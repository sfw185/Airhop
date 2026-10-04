// Renders the app icons (PNG) from the same 64-unit design as public/icon.svg.
// Usage: npx tsx scripts/icons.ts   (writes into public/)
import { writeFileSync } from 'node:fs';
import { encodePNG } from '../src/sim/png';

type Rect = [x: number, y: number, w: number, h: number, color: string];

const BG = '#0f1115';
// Design on a 64x64 grid, drawn in order (later rects on top). Mirrors public/icon.svg.
const DESIGN: Rect[] = [
  [8, 8, 22, 22, '#ffffff'],
  [11, 11, 16, 16, BG],
  [15, 15, 8, 8, '#ffffff'],
  [36, 36, 9, 9, '#ff4d4d'],
  [47, 36, 9, 9, '#33d17a'],
  [36, 47, 9, 9, '#4d7cff'],
  [47, 47, 9, 9, '#ffffff'],
  [36, 8, 9, 9, '#4d7cff'],
  [47, 19, 9, 9, '#ff4d4d'],
  [8, 36, 9, 9, '#33d17a'],
  [19, 47, 9, 9, '#ffffff'],
];

const hex = (c: string) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];

/**
 * Full-bleed square icon. `inset` scales the design about the centre: 1 for regular icons,
 * smaller for maskable icons whose content must sit inside the central safe circle.
 */
function render(size: number, inset: number): Uint8ClampedArray {
  const ss = 4; // supersampling per axis for clean edges at non-integer scales
  const out = new Uint8ClampedArray(size * size * 4);
  const bg = hex(BG);
  const rects = DESIGN.map(([x, y, w, h, c]) => ({ x, y, w, h, c: hex(c) }));
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          // Pixel sample -> design units, scaled about the centre (32, 32).
          const u = 32 + (((px + (sx + 0.5) / ss) / size) * 64 - 32) / inset;
          const v = 32 + (((py + (sy + 0.5) / ss) / size) * 64 - 32) / inset;
          let col = bg;
          for (const q of rects) if (u >= q.x && u < q.x + q.w && v >= q.y && v < q.y + q.h) col = q.c;
          r += col[0];
          g += col[1];
          b += col[2];
        }
      }
      const o = (py * size + px) * 4;
      out[o] = r / (ss * ss);
      out[o + 1] = g / (ss * ss);
      out[o + 2] = b / (ss * ss);
      out[o + 3] = 255;
    }
  }
  return out;
}

// The design spans 8..56 (48 units). Maskable icons must keep content inside a circle of
// radius 40% of the icon, so the 48-unit square's diagonal has to fit in 80% of the size.
const MASKABLE_INSET = (0.8 * 64) / (48 * Math.SQRT2) * 0.95;

const outputs: [file: string, size: number, inset: number][] = [
  ['icon-192.png', 192, 1],
  ['icon-512.png', 512, 1],
  ['icon-maskable-512.png', 512, MASKABLE_INSET],
  ['apple-touch-icon.png', 180, 0.92],
];
for (const [file, size, inset] of outputs) {
  writeFileSync(`public/${file}`, encodePNG(size, size, render(size, inset)));
  console.log(`public/${file} ${size}x${size}`);
}
