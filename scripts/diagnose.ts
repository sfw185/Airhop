// Prints per-frame decoder stages for one configuration. Usage:
//   npx tsx scripts/diagnose.ts W H bpc severity [camW camH] [frames]
import { getLayout } from '../src/core/layout';
import { encodeFrameRGB, rasterize } from '../src/core/frameEncoder';
import { FrameDecoder } from '../src/core/frameDecoder';
import { capture, randomCamera, type Severity } from '../src/sim/channel';
import { packTile, PACKET_SIZE } from '../src/core/tile';
const [W, H, bpc, sev, cw, ch, n] = [+process.argv[2], +process.argv[3], +process.argv[4], process.argv[5] as Severity, +(process.argv[6] ?? 1280), +(process.argv[7] ?? 720), +(process.argv[8] ?? 6)];
const layout = getLayout({ width: W, height: H, bpc: bpc as 2 | 3, ecc: 1 });
const tiles = layout.tiles.map((_, i) => packTile({ session: 1, transferLength: 1000, packet: new Uint8Array(PACKET_SIZE).fill(i) }));
for (let f = 0; f < n; f++) {
  const screen = rasterize(layout, encodeFrameRGB(layout, tiles), 6);
  const cam = randomCamera(5000 + f * 31 + W, screen.width, screen.height, { width: cw, height: ch, fill: 0.88, severity: sev });
  const r = new FrameDecoder().decode(capture(screen, cam));
  console.log(
    `${f} ${r.stage.padEnd(10)} finders=${r.finders.length} tiles=${r.tilesOk}/${layout.tiles.length} align=${r.alignFound}/${r.alignTotal} corr=${r.meanCorrections.toFixed(1)}`,
    `| blur=${cam.blur.toFixed(2)} k1=${cam.k1.toFixed(3)} gain=${cam.gain.toFixed(2)} amb=${cam.ambient.toFixed(3)} glare=${cam.glare ? cam.glare.s.toFixed(2) : '-'} moire=${cam.moire ? cam.moire.amp.toFixed(2) : '-'} noise=${cam.noise.toFixed(1)}`,
  );
}
