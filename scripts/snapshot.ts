// Saves the simulated camera image of one diagnose.ts frame and lists finder candidates.
// Usage: npx tsx scripts/snapshot.ts W H bpc severity frame out.png [camW camH]
import { writeFileSync } from 'node:fs';
import { getLayout } from '../src/core/layout';
import { encodeFrameRGB, rasterize } from '../src/core/frameEncoder';
import { capture, randomCamera, type Severity } from '../src/sim/channel';
import { packTile, PACKET_SIZE } from '../src/core/tile';
import { encodePNG } from '../src/sim/png';
import { FrameDecoder } from '../src/core/frameDecoder';
const [W, H, bpc, sev, f, out, cw, ch] = [+process.argv[2], +process.argv[3], +process.argv[4], process.argv[5] as Severity, +process.argv[6], process.argv[7], +(process.argv[8] ?? 1280), +(process.argv[9] ?? 720)];
const layout = getLayout({ width: W, height: H, bpc: bpc as 2 | 3, ecc: 1 });
const tiles = layout.tiles.map((_, i) => packTile({ session: 1, transferLength: 1000, packet: new Uint8Array(PACKET_SIZE).fill(i) }));
const screen = rasterize(layout, encodeFrameRGB(layout, tiles), 6);
const cam = randomCamera(5000 + f * 31 + W, screen.width, screen.height, { width: cw, height: ch, fill: 0.88, severity: sev });
const img = capture(screen, cam);
const r = new FrameDecoder().decode(img);
console.log(r.stage, r.finders.map((x) => `${x.x.toFixed(0)},${x.y.toFixed(0)} m${x.module.toFixed(1)} n${x.count}`).join(' | '));
console.log('true corners', cam.corners.map((p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(' '));
writeFileSync(out, encodePNG(img.width, img.height, img.data));
