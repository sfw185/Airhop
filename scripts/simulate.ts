// Sweeps grid sizes / palettes / channel severities through the synthetic camera and reports
// tile decode rates. Usage: npm run sim -- [frames-per-config] [camera WxH]
import { getLayout } from '../src/core/layout';
import { encodeFrameRGB, rasterize } from '../src/core/frameEncoder';
import { FrameDecoder } from '../src/core/frameDecoder';
import { packTile, PACKET_SIZE } from '../src/core/tile';
import { capture, randomCamera, type Severity } from '../src/sim/channel';
import { mulberry32 } from '../src/core/prng';
import { ECC_NAMES, type BitsPerCell, type EccLevel } from '../src/core/format';

const frames = Number(process.argv[2] ?? 6);
const [camW, camH] = (process.argv[3] ?? '1280x720').split('x').map(Number);
const only = process.env.ONLY;

const configs: { W: number; H: number; bpc: BitsPerCell; ecc: EccLevel }[] = [];
for (const [W, H] of [
  [128, 72],
  [192, 108 - (108 % 8)],
  [256, 144],
  [320, 176],
]) {
  for (const bpc of [2, 3] as BitsPerCell[]) configs.push({ W, H, bpc, ecc: 1 });
}
const severities: Severity[] = ['mild', 'moderate', 'harsh'];

const rand = mulberry32(7);
const rows: string[] = [];
for (const cfg of configs) {
  const layout = getLayout({ width: cfg.W, height: cfg.H, bpc: cfg.bpc, ecc: cfg.ecc });
  if (only && !layout.key.startsWith(only)) continue;
  const cells = [];
  for (const sev of severities) {
    const dec = new FrameDecoder();
    let ok = 0, tot = 0, located = 0, ms = 0;
    for (let f = 0; f < frames; f++) {
      const tiles = layout.tiles.map(() => {
        const pkt = new Uint8Array(PACKET_SIZE);
        for (let k = 0; k < PACKET_SIZE; k++) pkt[k] = rand() & 255;
        return packTile({ session: 1, transferLength: 1, packet: pkt });
      });
      const screen = rasterize(layout, encodeFrameRGB(layout, tiles), 6);
      const cam = randomCamera(5000 + f * 31 + cfg.W, screen.width, screen.height, { width: camW, height: camH, fill: 0.88, severity: sev });
      const r = dec.decode(capture(screen, cam));
      if (r.stage === 'decoded') located++;
      ok += r.tilesOk;
      tot += layout.tiles.length;
      ms += r.ms;
    }
    cells.push(`${sev}: ${((100 * ok) / tot).toFixed(0).padStart(3)}% (loc ${located}/${frames}, ${(ms / frames).toFixed(0)}ms)`);
  }
  const pxPerCell = (camW * 0.88) / (cfg.W + 6);
  rows.push(`${layout.key.padEnd(14)} ECC ${ECC_NAMES[cfg.ecc]} ${(layout.payloadPerFrame / 1024).toFixed(1).padStart(5)} KB/frame ~${pxPerCell.toFixed(1)}px/cell | ${cells.join(' | ')}`);
  console.log(rows[rows.length - 1]);
}
