// Captures UI screenshots (desktop + phone) of the built app into the given directory.
// Usage: npx vite build && npx tsx scripts/screenshots.ts out
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';
const SP = process.argv[2];
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = createServer((req, res) => {
  let p = join('dist', decodeURIComponent((req.url ?? '/').split('?')[0]));
  if (!existsSync(p) || statSync(p).isDirectory()) p = join('dist', 'index.html');
  res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
  createReadStream(p).pipe(res);
});
await new Promise<void>((r) => server.listen(5199, '127.0.0.1', () => r()));
const base = 'http://127.0.0.1:5199';
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const desk = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await desk.goto(base + '/'); await desk.waitForSelector('.pwa .ok', { timeout: 30000 }).catch(() => {}); await desk.screenshot({ path: `${SP}/home.png` });
await desk.goto(base + '/#send'); await desk.waitForTimeout(300); await desk.screenshot({ path: `${SP}/send-setup.png` });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await ctx.grantPermissions(['camera'], { origin: base });
const phone = await ctx.newPage();
await phone.goto(base + '/'); await phone.screenshot({ path: `${SP}/phone-home.png` });
await phone.goto(base + '/?autostart#receive'); await phone.waitForTimeout(2500); await phone.screenshot({ path: `${SP}/phone-receive.png` });
await browser.close(); server.close();
