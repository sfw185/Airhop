// Locates the four finder patterns in a camera frame.
// Binarisation uses a block-wise local-mean threshold; finder search follows the classic
// QR approach: scan rows for a 1:1:3:1:1 dark/light run ratio, then cross-check vertically,
// horizontally and diagonally, and cluster the hits.

export interface Gray {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface FinderCandidate {
  x: number;
  y: number;
  module: number;
  count: number;
}

export class Binarizer {
  private blockSum = new Float64Array(0);
  private blockIntegral = new Float64Array(0);
  private blockThr = new Float32Array(0);
  bin = new Uint8Array(0);

  /**
   * Local-mean threshold, computed on 8x8 pixel blocks: block means are box-filtered over a
   * window of roughly `window` pixels and every pixel is compared with its block's threshold.
   * Much cheaper than a per-pixel integral image and just as good for finder detection.
   */
  run(g: Gray, window?: number): Uint8Array {
    const { width: w, height: h, data } = g;
    const B = 8;
    const bw = Math.ceil(w / B), bh = Math.ceil(h / B);
    if (this.blockSum.length !== bw * bh) {
      this.blockSum = new Float64Array(bw * bh);
      this.blockIntegral = new Float64Array((bw + 1) * (bh + 1));
      this.blockThr = new Float32Array(bw * bh);
    }
    if (this.bin.length !== w * h) this.bin = new Uint8Array(w * h);
    const sum = this.blockSum;
    sum.fill(0);
    for (let y = 0; y < h; y++) {
      const row = (y >> 3) * bw;
      const lo = y * w;
      for (let x = 0; x < w; x++) sum[row + (x >> 3)] += data[lo + x];
    }
    // Normalise partial edge blocks to per-pixel means.
    for (let by = 0; by < bh; by++) {
      const hh = Math.min(B, h - by * B);
      for (let bx = 0; bx < bw; bx++) sum[by * bw + bx] /= hh * Math.min(B, w - bx * B);
    }
    const I = this.blockIntegral;
    const W1 = bw + 1;
    for (let by = 0; by < bh; by++) {
      let rs = 0;
      for (let bx = 0; bx < bw; bx++) {
        rs += sum[by * bw + bx];
        I[(by + 1) * W1 + bx + 1] = I[by * W1 + bx + 1] + rs;
      }
    }
    const R = Math.max(2, Math.round((window ?? Math.min(w, h) / 8) / 2 / B));
    const thr = this.blockThr;
    for (let by = 0; by < bh; by++) {
      const y0 = Math.max(0, by - R), y1 = Math.min(bh, by + R + 1);
      for (let bx = 0; bx < bw; bx++) {
        const x0 = Math.max(0, bx - R), x1 = Math.min(bw, bx + R + 1);
        const s = I[y1 * W1 + x1] - I[y1 * W1 + x0] - I[y0 * W1 + x1] + I[y0 * W1 + x0];
        // dark if lum < 0.92 * local mean
        thr[by * bw + bx] = ((s / ((y1 - y0) * (x1 - x0))) * 23) / 25;
      }
    }
    const bin = this.bin;
    for (let y = 0; y < h; y++) {
      const row = (y >> 3) * bw;
      const lo = y * w;
      for (let x = 0; x < w; x++) bin[lo + x] = data[lo + x] < thr[row + (x >> 3)] ? 1 : 0;
    }
    return bin;
  }
}

export function toGray(rgba: ArrayLike<number>, width: number, height: number, out?: Uint8Array): Gray {
  const n = width * height;
  const data = out && out.length === n ? out : new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) data[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  return { width, height, data };
}

/**
 * Distance between the centres of the two outer dark runs: six modules. Unlike the total width it
 * is not biased by where the binarisation threshold falls on blurred edges.
 */
function outerSpan(c: number[]): number {
  return c[0] / 2 + c[1] + c[2] + c[3] + c[4] / 2;
}

function ratioOk(c: number[]): boolean {
  const total = c[0] + c[1] + c[2] + c[3] + c[4];
  if (total < 7) return false;
  const m = total / 7;
  const v = m * 0.6;
  return (
    Math.abs(m - c[0]) < v &&
    Math.abs(m - c[1]) < v &&
    Math.abs(3 * m - c[2]) < 3 * v &&
    Math.abs(m - c[3]) < v &&
    Math.abs(m - c[4]) < v
  );
}

export function findFinders(bin: Uint8Array, w: number, h: number): FinderCandidate[] {
  const cands: FinderCandidate[] = [];
  const at = (x: number, y: number) => bin[y * w + x];

  const crossCheck = (cx: number, cy: number, dx: number, dy: number, maxCount: number, origTotal: number): { pos: number; total: number; span: number } | null => {
    // Walk from (cx, cy) along (dx, dy) in both directions. Returns centre offset along the line.
    const c = [0, 0, 0, 0, 0];
    let x = cx, y = cy;
    const inside = (xx: number, yy: number) => xx >= 0 && yy >= 0 && xx < w && yy < h;
    while (inside(x, y) && at(x, y)) {
      c[2]++;
      x -= dx;
      y -= dy;
    }
    if (!inside(x, y)) return null;
    while (inside(x, y) && !at(x, y) && c[1] <= maxCount) {
      c[1]++;
      x -= dx;
      y -= dy;
    }
    if (!inside(x, y) || c[1] > maxCount) return null;
    while (inside(x, y) && at(x, y) && c[0] <= maxCount) {
      c[0]++;
      x -= dx;
      y -= dy;
    }
    if (c[0] > maxCount) return null;
    x = cx + dx;
    y = cy + dy;
    let fwd = 0;
    while (inside(x, y) && at(x, y)) {
      c[2]++;
      fwd++;
      x += dx;
      y += dy;
    }
    if (!inside(x, y)) return null;
    while (inside(x, y) && !at(x, y) && c[3] <= maxCount) {
      c[3]++;
      x += dx;
      y += dy;
    }
    if (!inside(x, y) || c[3] > maxCount) return null;
    while (inside(x, y) && at(x, y) && c[4] <= maxCount) {
      c[4]++;
      x += dx;
      y += dy;
    }
    if (c[4] > maxCount) return null;
    const total = c[0] + c[1] + c[2] + c[3] + c[4];
    if (5 * Math.abs(total - origTotal) >= 3 * origTotal) return null;
    if (!ratioOk(c)) return null;
    // Centre of the middle run relative to (cx, cy), in steps.
    const pos = fwd + 0.5 - c[2] / 2;
    return { pos, total, span: outerSpan(c) };
  };

  const handle = (cxF: number, y: number, counts: number[]) => {
    const total = counts.reduce((a, b) => a + b, 0);
    const cx = Math.round(cxF);
    const v = crossCheck(cx, y, 0, 1, counts[2] * 1.5 + 2, total);
    if (!v) return;
    const cy = Math.round(y + v.pos);
    const hz = crossCheck(cx, cy, 1, 0, counts[2] * 1.5 + 2, total);
    if (!hz) return;
    const fx = cx + hz.pos;
    const fy = y + v.pos;
    // Diagonal sanity check.
    const dg = crossCheck(Math.round(fx), Math.round(fy), 1, 1, counts[2] * 2 + 2, total);
    if (!dg) return;
    const module = (outerSpan(counts) + v.span + hz.span) / 18;
    for (const c of cands) {
      if (Math.abs(c.x - fx) <= module * 1.5 && Math.abs(c.y - fy) <= module * 1.5 && Math.abs(c.module - module) < Math.max(1, c.module * 0.4)) {
        const n = c.count + 1;
        c.x = (c.x * c.count + fx) / n;
        c.y = (c.y * c.count + fy) / n;
        c.module = (c.module * c.count + module) / n;
        c.count = n;
        return;
      }
    }
    cands.push({ x: fx, y: fy, module, count: 1 });
  };

  const step = h >= 900 ? 2 : 1;
  const runs = new Int32Array(w + 1);
  for (let y = 0; y < h; y += step) {
    // Run-length encode the row, starting with a light run (possibly empty).
    let nr = 0;
    let cur = 0; // colour of current run: 0 light, 1 dark
    let len = 0;
    const lo = y * w;
    for (let x = 0; x < w; x++) {
      const b = bin[lo + x];
      if (b === cur) len++;
      else {
        runs[nr++] = len;
        cur = b;
        len = 1;
      }
    }
    runs[nr++] = len;
    // Runs alternate light/dark starting with light at index 0, so dark runs are odd indices.
    let xEnd = runs[0];
    for (let i = 1; i + 4 < nr; i += 2) {
      const counts = [runs[i], runs[i + 1], runs[i + 2], runs[i + 3], runs[i + 4]];
      if (ratioOk(counts)) {
        const startX = xEnd;
        const centerX = startX + counts[0] + counts[1] + counts[2] / 2 - 0.5;
        handle(centerX, y, counts);
      }
      xEnd += runs[i] + runs[i + 1];
    }
  }
  const minCount = step === 1 ? 2 : 1;
  return cands.filter((c) => c.count >= minCount).sort((a, b) => b.count - a.count);
}
