import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { initFountainSync } from '../src/core/fountain';
import { encodeFrameRGB, rasterize } from '../src/core/frameEncoder';
import { FrameDecoder } from '../src/core/frameDecoder';
import { getLayout } from '../src/core/layout';
import { mulberry32 } from '../src/core/prng';
import { packFile, ReceiveSession, SendSession, unpackFile } from '../src/core/transfer';
import { capture, randomCamera } from '../src/sim/channel';
import { decodeFormatBits, encodeFormatBits, type FrameFormat } from '../src/core/format';

const require = createRequire(import.meta.url);
initFountainSync(readFileSync(require.resolve('raptorq/raptorq_bg.wasm')));

function randomBytes(n: number, seed: number): Uint8Array {
  const r = mulberry32(seed);
  return Uint8Array.from({ length: n }, () => r() & 255);
}

describe('format word', () => {
  it('round-trips and rejects the wrong corner', () => {
    const f: FrameFormat = { width: 200, height: 112, bpc: 3, ecc: 2 };
    for (let c = 0; c < 4; c++) {
      expect(decodeFormatBits(encodeFormatBits(f, c), c)).toEqual(f);
      expect(decodeFormatBits(encodeFormatBits(f, c), (c + 1) % 4)).toBeNull();
    }
  });
});

describe('layout', () => {
  it('assigns every cell exactly one role and fills tiles completely', () => {
    for (const [W, H] of [[40, 40], [128, 72], [176, 96], [320, 176], [512, 288]]) {
      for (const bpc of [1, 2, 3] as const) {
        const l = getLayout({ width: W, height: H, bpc, ecc: 1 });
        if (W * H * bpc >= 8 * 8192) expect(l.tiles.length).toBeGreaterThan(0);
        const seen = new Set<number>();
        for (const t of l.tiles) {
          expect(t.cells.length).toBe(Math.ceil((t.n * 8) / bpc));
          for (const c of t.cells) {
            expect(seen.has(c)).toBe(false);
            seen.add(c);
          }
        }
      }
    }
  });
});

describe('end-to-end over the simulated channel', () => {
  it('reconstructs a file from camera captures, with frame loss', async () => {
    const original = randomBytes(30_000, 99);
    const transfer = await packFile({ name: 'random.bin', mime: 'application/octet-stream', data: original });
    const send = new SendSession(transfer);
    const layout = getLayout({ width: 160, height: 96, bpc: 2, ecc: 1 });
    const dec = new FrameDecoder();
    const recv = new ReceiveSession();
    let frames = 0;
    while (!recv.completed && frames < 200) {
      const tiles = send.next(layout.tiles.length);
      frames++;
      if (frames % 4 === 0) continue; // drop every 4th frame
      const screen = rasterize(layout, encodeFrameRGB(layout, tiles), 5);
      const cam = randomCamera(frames, screen.width, screen.height, { width: 960, height: 540, fill: 0.9, severity: 'mild' });
      const r = dec.decode(capture(screen, cam));
      recv.add(r.payloads);
    }
    expect(recv.completed).not.toBeNull();
    const file = await unpackFile(recv.completed!.bytes);
    expect(file.crcOk).toBe(true);
    expect(file.name).toBe('random.bin');
    expect(Buffer.from(file.data).equals(Buffer.from(original))).toBe(true);
    // ~30 KB in 160x96x2bpc frames (15 tiles x 176 B) needs ~12 frames' worth plus losses.
    expect(frames).toBeLessThan(30);
  });

  it('compresses text and survives a mid-transfer density change', async () => {
    const text = 'Airhop moves files over light. '.repeat(3000);
    const data = new TextEncoder().encode(text);
    const transfer = await packFile({ name: 'notes.txt', mime: 'text/plain', data });
    expect(transfer.length).toBeLessThan(data.length / 10);
    const send = new SendSession(transfer);
    const recv = new ReceiveSession();
    const dec = new FrameDecoder();
    const layouts = [getLayout({ width: 64, height: 48, bpc: 2, ecc: 2 }), getLayout({ width: 96, height: 64, bpc: 3, ecc: 1 })];
    let f = 0;
    while (!recv.completed && f < 50) {
      const layout = layouts[f < 2 ? 0 : 1];
      const screen = rasterize(layout, encodeFrameRGB(layout, send.next(layout.tiles.length)), 4);
      recv.add(dec.decode({ width: screen.width, height: screen.height, data: screen.data }).payloads);
      f++;
    }
    const file = await unpackFile(recv.completed!.bytes);
    expect(file.crcOk).toBe(true);
    expect(new TextDecoder().decode(file.data)).toBe(text);
  });
});
