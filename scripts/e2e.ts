// End-to-end test in real Chromium.
//  A) Sender page: screenshots of the live code -> simulated camera -> Node decoder -> file.
//  B) Receiver page: a Y4M "camera" video (sender frames through the simulated channel, with
//     rolling-shutter seams and 4:2:0 chroma) fed to Chromium's fake webcam -> file.
import { execSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';
import { initFountainSync } from '../src/core/fountain';
import { FrameDecoder } from '../src/core/frameDecoder';
import { encodeFrameRGB, rasterize } from '../src/core/frameEncoder';
import { getLayout } from '../src/core/layout';
import { mulberry32 } from '../src/core/prng';
import { packFile, ReceiveSession, SendSession, unpackFile } from '../src/core/transfer';
import { capture, randomCamera } from '../src/sim/channel';
import { decodePNG, encodePNG } from '../src/sim/png';
import { Y4MWriter } from '../src/sim/y4m';

const require = createRequire(import.meta.url);
initFountainSync(readFileSync(require.resolve('raptorq/raptorq_bg.wasm')));
const CHROME = process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const OUT = process.env.E2E_OUT ?? 'out';
mkdirSync(OUT, { recursive: true });

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };
function serve(dir: string): Promise<{ url: string; close: () => void }> {
  const server = createServer((req, res) => {
    let p = join(dir, decodeURIComponent((req.url ?? '/').split('?')[0]));
    if (!existsSync(p) || statSync(p).isDirectory()) p = join(dir, 'index.html');
    res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
    createReadStream(p).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const a = server.address() as { port: number };
    resolve({ url: `http://127.0.0.1:${a.port}`, close: () => server.close() });
  }));
}

function randomBytes(n: number, seed: number): Uint8Array {
  const r = mulberry32(seed);
  return Uint8Array.from({ length: n }, () => r() & 255);
}

async function senderTest(base: string) {
  console.log('[A] sender page -> simulated camera -> decoder');
  const data = randomBytes(24_000, 1);
  writeFileSync(join(OUT, 'send-input.bin'), data);
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  page.on('console', (m) => m.type() === 'error' && console.log('  page:', m.text()));
  await page.goto(`${base}/#send`);
  await page.setInputFiles('input[type=file]', join(OUT, 'send-input.bin'));
  await page.waitForSelector('.stage canvas');
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'sender.png') });
  const dec = new FrameDecoder();
  const recv = new ReceiveSession();
  const t0 = Date.now();
  let shots = 0;
  while (!recv.completed && Date.now() - t0 < 90_000) {
    const png = await page.locator('.stage').screenshot();
    const screen = decodePNG(png);
    const cam = randomCamera(100 + shots, screen.width, screen.height, { width: 1280, height: 720, fill: 0.95, severity: 'mild' });
    const r = dec.decode(capture(screen, cam));
    recv.add(r.payloads);
    shots++;
    if (shots === 1) writeFileSync(join(OUT, 'sender-captured.png'), encodePNG(1280, 720, capture(screen, cam).data));
    const p = recv.progress();
    console.log(`  shot ${shots}: ${r.stage} ${r.format ? `${r.format.width}x${r.format.height}/${r.format.bpc}` : ''} tiles ${r.tilesOk}/${r.tilesTotal} progress ${p ? `${p.unique}/${p.needed}` : '-'}`);
  }
  await browser.close();
  if (!recv.completed) throw new Error('[A] sender page transfer did not complete');
  const file = await unpackFile(recv.completed.bytes);
  if (!file.crcOk || Buffer.compare(Buffer.from(file.data), Buffer.from(data)) !== 0) throw new Error('[A] data mismatch');
  console.log(`[A] OK: ${file.name} ${file.data.length} bytes from ${shots} screenshots`);
}

async function receiverTest(base: string) {
  console.log('[B] Y4M fake camera -> receiver page');
  const data = randomBytes(40_000, 2);
  const transfer = await packFile({ name: 'camera-test.bin', mime: 'application/octet-stream', data });
  const send = new SendSession(transfer);
  const layout = getLayout({ width: 192, height: 104, bpc: 3, ecc: 1 });
  const needFrames = Math.ceil(send.sourceSymbols / layout.tiles.length);
  const senderFrames = needFrames * 2 + 4;
  const y4mPath = join(OUT, 'camera.y4m');
  const camW = 1280, camH = 720;
  const y4m = new Y4MWriter(y4mPath, camW, camH, 30);
  let prev = rasterize(layout, encodeFrameRGB(layout, send.next(layout.tiles.length)), 6);
  for (let f = 0; f < senderFrames; f++) {
    const next = rasterize(layout, encodeFrameRGB(layout, send.next(layout.tiles.length)), 6);
    const cam = randomCamera(900 + f, prev.width, prev.height, { width: camW, height: camH, fill: 0.88, severity: 'mild' });
    // Each sender frame lasts three camera frames at 30 fps (10 fps code). The last one catches
    // the display switching mid-readout.
    const clean = capture(prev, cam);
    y4m.write(clean.data);
    y4m.write(clean.data);
    y4m.write(capture(prev, { ...cam, seam: 0.3 + 0.4 * ((f * 37) % 10) / 10 }, next).data);
    if (f === 0) writeFileSync(join(OUT, 'camera-frame.png'), encodePNG(camW, camH, clean.data));
    prev = next;
  }
  y4m.close();
  console.log(`  wrote ${senderFrames * 3} camera frames (${senderFrames} code frames, ${needFrames} needed)`);
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${y4mPath}`],
  });
  const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
  await context.grantPermissions(['camera'], { origin: base });
  const page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && console.log('  page:', m.text()));
  await page.goto(`${base}/?autostart#receive`);
  const res = await page.waitForFunction(() => (window as unknown as { __airhopResult?: unknown }).__airhopResult, null, { timeout: 120_000, polling: 250 }).catch(async (e) => {
    await page.screenshot({ path: join(OUT, 'receiver-timeout.png') });
    console.log('  status:', await page.locator('.status').textContent(), '|', await page.locator('.stats').textContent());
    throw e;
  });
  const result = (await res.jsonValue()) as { name: string; size: number; crcOk: boolean; frames: number; secs: number };
  await page.screenshot({ path: join(OUT, 'receiver.png') });
  console.log('  status:', await page.locator('.stats').textContent());
  await browser.close();
  if (result.name !== 'camera-test.bin' || result.size !== data.length || !result.crcOk) throw new Error(`[B] bad result ${JSON.stringify(result)}`);
  console.log(`[B] OK: ${result.name} ${result.size} bytes, crc ok, ${result.frames} frames decoded in ${result.secs.toFixed(1)}s`);
}

if (!process.env.SKIP_BUILD) execSync('npx vite build', { stdio: 'inherit' });
const srv = await serve('dist');
try {
  if (!process.env.ONLY || process.env.ONLY === 'A') await senderTest(srv.url);
  if (!process.env.ONLY || process.env.ONLY === 'B') await receiverTest(srv.url);
} finally {
  srv.close();
}
