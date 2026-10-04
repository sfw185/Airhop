// End-to-end test in real Chromium.
//  A) Sender page: screenshots of the live code -> simulated camera -> Node decoder -> file.
//  B) Receiver page: a Y4M "camera" video (sender frames through the simulated channel, with
//     rolling-shutter seams and 4:2:0 chroma) fed to Chromium's fake webcam -> file.
//  C) Offline: one online visit, then with the network gone, reload, send and receive.
//  D) Updates: a new deploy waits until the user taps "reload", then cleanly takes over.
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

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};
function serve(dir: string): Promise<{ url: string; close: () => void }> {
  const server = createServer((req, res) => {
    if (serverDown) {
      req.socket.destroy();
      return;
    }
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

/** When true the static server drops every connection, like a device with no network. */
let serverDown = false;

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

interface CameraVideo {
  path: string;
  data: Uint8Array;
  name: string;
}
let cameraVideo: CameraVideo | null = null;

/** Sender frames through the simulated camera, written as a Y4M file for Chromium's fake webcam. */
async function makeCameraVideo(): Promise<CameraVideo> {
  if (cameraVideo) return cameraVideo;
  const data = randomBytes(40_000, 2);
  const name = 'camera-test.bin';
  const transfer = await packFile({ name, mime: 'application/octet-stream', data });
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
  cameraVideo = { path: y4mPath, data, name };
  return cameraVideo;
}

async function receiverTest(base: string) {
  console.log('[B] Y4M fake camera -> receiver page');
  const { path: y4mPath, data } = await makeCameraVideo();
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

async function offlineTest(base: string) {
  console.log('[C] first visit online, then send and receive with no network at all');
  const video = await makeCameraVideo();
  const sendInput = join(OUT, 'send-input.bin');
  if (!existsSync(sendInput)) writeFileSync(sendInput, randomBytes(24_000, 1));
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${video.path}`],
  });
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  await context.grantPermissions(['camera'], { origin: base });
  const page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && console.log('  page:', m.text()));
  await page.goto(`${base}/`);
  await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1));
  // One online visit: the service worker precaches everything and takes control.
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30_000 });
  await page.waitForSelector('.pwa .ok', { timeout: 30_000 });
  if (!(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker))) throw new Error('[C] first install reloaded the page');
  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    const c = await caches.open(keys[0]);
    return { keys, entries: (await c.keys()).map((r) => new URL(r.url).pathname) };
  });
  console.log(`  precached ${cached.entries.length} files in ${cached.keys.join(', ')}`);

  serverDown = true;
  await context.setOffline(true);
  try {
    await page.reload();
    await page.waitForSelector('h1');
    const icons = await page.evaluate(async () => {
      const m = await (await fetch('./manifest.webmanifest')).json();
      return Promise.all((m.icons as { src: string }[]).map(async (i) => (await fetch(i.src)).ok));
    });
    if (!icons.length || !icons.every(Boolean)) throw new Error('[C] manifest icons not available offline');
    console.log(`  offline: home page and ${icons.length} manifest icons load`);

    await page.goto(`${base}/#send`);
    await page.setInputFiles('input[type=file]', sendInput);
    await page.waitForSelector('.stage canvas');
    await page.waitForTimeout(400);
    const shot = decodePNG(await page.locator('.stage').screenshot());
    const r = new FrameDecoder().decode(shot);
    if (r.stage !== 'decoded' || r.tilesOk === 0) throw new Error(`[C] offline sender did not render a decodable code (${r.stage})`);
    console.log(`  offline: sender renders a decodable code (${r.tilesOk}/${r.tilesTotal} tiles)`);

    const rx = await context.newPage();
    rx.on('console', (m) => m.type() === 'error' && console.log('  page:', m.text()));
    await rx.goto(`${base}/?autostart#receive`);
    const res = await rx.waitForFunction(() => (window as unknown as { __airhopResult?: unknown }).__airhopResult, null, { timeout: 120_000, polling: 250 }).catch(async (e) => {
      await rx.screenshot({ path: join(OUT, 'offline-receiver-timeout.png') });
      console.log('  status:', await rx.locator('.status').textContent(), '|', await rx.locator('.stats').textContent(), '|', await rx.locator('.error').textContent());
      throw e;
    });
    const result = (await res.jsonValue()) as { name: string; size: number; crcOk: boolean };
    if (result.name !== video.name || result.size !== video.data.length || !result.crcOk) throw new Error(`[C] bad offline result ${JSON.stringify(result)}`);
    console.log(`[C] OK: offline reload, send, and receive (${result.size} bytes, crc ok)`);
  } finally {
    serverDown = false;
    await browser.close();
  }
}

async function updateTest(base: string) {
  console.log('[D] a new deploy waits for the user instead of replacing an open page');
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage();
  await page.goto(`${base}/`);
  await page.waitForSelector('.pwa .ok', { timeout: 30_000 });
  const askVersion = () =>
    page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          navigator.serviceWorker.addEventListener('message', (e) => resolve(e.data.version), { once: true });
          navigator.serviceWorker.controller!.postMessage('version');
        }),
    );
  const v1 = await askVersion();
  await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1));
  // "Deploy" a new version by changing the worker's version string.
  const swPath = join('dist', 'sw.js');
  const original = readFileSync(swPath, 'utf8');
  writeFileSync(swPath, original.replace(/const VERSION = '([0-9a-f]+)'/, "const VERSION = 'test2$1'"));
  try {
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.update());
    const button = page.locator('.pwa button', { hasText: 'Update ready' });
    await button.waitFor({ timeout: 30_000 });
    if (!(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker))) throw new Error('[D] page reloaded before the user asked');
    if ((await askVersion()) !== v1) throw new Error('[D] new version took over an open page');
    await Promise.all([page.waitForEvent('load', { timeout: 30_000 }), button.click()]);
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null);
    const v2 = await askVersion();
    if (!v2.startsWith('test2')) throw new Error(`[D] still on ${v2} after reload`);
    const cacheNames = await page.evaluate(() => caches.keys());
    if (cacheNames.length !== 1) throw new Error(`[D] old caches not cleaned up: ${cacheNames.join(', ')}`);
    console.log(`[D] OK: ${v1} kept until reload, then ${v2}; old cache removed`);
  } finally {
    writeFileSync(swPath, original);
    await browser.close();
  }
}

if (!process.env.SKIP_BUILD) execSync('npx vite build', { stdio: 'inherit' });
const srv = await serve('dist');
try {
  if (!process.env.ONLY || process.env.ONLY === 'A') await senderTest(srv.url);
  if (!process.env.ONLY || process.env.ONLY === 'B') await receiverTest(srv.url);
  if (!process.env.ONLY || process.env.ONLY === 'C') await offlineTest(srv.url);
  if (!process.env.ONLY || process.env.ONLY === 'D') await updateTest(srv.url);
} finally {
  srv.close();
}
