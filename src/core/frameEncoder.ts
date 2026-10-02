import type { Layout } from './layout';
import { keystream } from './prng';
import { rsEncode } from './rs';
import { TILE_DATA } from './format';

export const TILE_SCRAMBLE_SEED = 0x5eed0000;

/** Converts a tile codeword into bytes padded to the tile's cell capacity and scrambled. */
export function scrambledTileBytes(codeword: Uint8Array, tileIndex: number, cellCount: number, bpc: number): Uint8Array {
  const total = Math.ceil((cellCount * bpc) / 8);
  const ks = keystream(TILE_SCRAMBLE_SEED + tileIndex, total);
  const out = new Uint8Array(total);
  for (let i = 0; i < total; i++) out[i] = (i < codeword.length ? codeword[i] : 0) ^ ks[i];
  return out;
}

/**
 * Builds the palette-index grid for one frame. tileData[i] must be TILE_DATA bytes; missing
 * entries are filled with pseudo-random bytes so the frame keeps uniform colour statistics.
 * Returns W*H RGB bytes.
 */
export function encodeFrameRGB(layout: Layout, tileData: (Uint8Array | null | undefined)[], frameSeed = 0): Uint8Array {
  const { bpc, palette } = layout;
  const rgb = layout.template.slice();
  const mask = (1 << bpc) - 1;
  for (let t = 0; t < layout.tiles.length; t++) {
    const tile = layout.tiles[t];
    let data = tileData[t];
    if (!data) data = keystream(0xdead0000 ^ (frameSeed * 7919 + t), TILE_DATA);
    const cw = rsEncode(data, tile.nsym);
    const bytes = scrambledTileBytes(cw, t, tile.cells.length, bpc);
    let bitPos = 0;
    for (let c = 0; c < tile.cells.length; c++) {
      let v = 0;
      for (let b = 0; b < bpc; b++, bitPos++) v = (v << 1) | ((bytes[bitPos >> 3] >> (7 - (bitPos & 7))) & 1);
      const col = palette[v & mask];
      const o = tile.cells[c] * 3;
      rgb[o] = col[0];
      rgb[o + 1] = col[1];
      rgb[o + 2] = col[2];
    }
  }
  return rgb;
}

/** Expands a cell RGB grid into an RGBA image with a quiet zone, `scale` pixels per cell. */
export function rasterize(layout: Layout, rgb: Uint8Array, scale: number, quiet = 3): { width: number; height: number; data: Uint8ClampedArray } {
  const width = (layout.W + quiet * 2) * scale;
  const height = (layout.H + quiet * 2) * scale;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < layout.H; y++) {
    for (let x = 0; x < layout.W; x++) {
      const o = (y * layout.W + x) * 3;
      const r = rgb[o], g = rgb[o + 1], b = rgb[o + 2];
      const px0 = (x + quiet) * scale;
      const py0 = (y + quiet) * scale;
      for (let py = py0; py < py0 + scale; py++) {
        let p = (py * width + px0) * 4;
        for (let px = 0; px < scale; px++, p += 4) {
          data[p] = r;
          data[p + 1] = g;
          data[p + 2] = b;
        }
      }
    }
  }
  return { width, height, data };
}
