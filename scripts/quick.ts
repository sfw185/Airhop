import { getLayout } from '../src/core/layout';
import { encodeFrameRGB, rasterize } from '../src/core/frameEncoder';
import { FrameDecoder } from '../src/core/frameDecoder';
import { packTile, PACKET_SIZE } from '../src/core/tile';
import { capture, randomCamera, type Severity } from '../src/sim/channel';
import { mulberry32 } from '../src/core/prng';
import type { BitsPerCell, EccLevel } from '../src/core/format';

const [camW, camH, fill] = [Number(process.env.CAMW ?? 1280), Number(process.env.CAMH ?? 720), Number(process.env.FILL ?? 0.85)];
const [W, H, bpc, ecc, sev, n] = [Number(process.argv[2] ?? 120), Number(process.argv[3] ?? 72), Number(process.argv[4] ?? 2), Number(process.argv[5] ?? 1), (process.argv[6] ?? 'clean') as Severity, Number(process.argv[7] ?? 5)];
const layout = getLayout({ width: W, height: H, bpc: bpc as BitsPerCell, ecc: ecc as EccLevel });
console.log(`layout ${layout.key}: tiles=${layout.tiles.length} nodes=${layout.nodes.length} (${layout.nodes.filter((x) => x.kind === 'align').length} align) payload/frame=${layout.payloadPerFrame}B raw=${layout.rawBitsPerFrame / 8}B eff=${(layout.payloadPerFrame / (layout.rawBitsPerFrame / 8)).toFixed(2)}`);
const rand = mulberry32(42);
const dec = new FrameDecoder();
let okT = 0, totT = 0;
for (let f = 0; f < n; f++) {
  const tiles = layout.tiles.map(() => {
    const pkt = new Uint8Array(PACKET_SIZE);
    for (let k = 0; k < PACKET_SIZE; k++) pkt[k] = rand() & 255;
    return packTile({ session: 0x1234, transferLength: 100000, packet: pkt });
  });
  const rgb = encodeFrameRGB(layout, tiles);
  const screen = rasterize(layout, rgb, 8);
  const cam = randomCamera(1000 + f, screen.width, screen.height, { width: camW, height: camH, fill, severity: sev });
  const t0 = performance.now();
  const img = capture(screen, cam);
  const tc = performance.now() - t0;
  const r = dec.decode(img);
  okT += r.tilesOk; totT += r.tilesTotal || layout.tiles.length;
  console.log(`frame ${f}: stage=${r.stage} finders=${r.finders.length} tiles=${r.tilesOk}/${r.tilesTotal} align=${r.alignFound}/${r.alignTotal} corr=${r.meanCorrections.toFixed(1)} decode=${r.ms.toFixed(1)}ms capture=${tc.toFixed(0)}ms`);
}
console.log(`total ${okT}/${totT}`);
