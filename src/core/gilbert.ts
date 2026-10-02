// Generalized Hilbert curve for arbitrary rectangles (after Jakub Cervený's gilbert2d).
// Consecutive runs along the curve form compact regions, which is what we want for tiles:
// a rolling-shutter seam or a glare spot then only touches a few tiles.

export function gilbert2d(width: number, height: number): Int32Array {
  const out = new Int32Array(width * height);
  let n = 0;
  const emit = (x: number, y: number) => {
    out[n++] = y * width + x;
  };
  const sgn = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : 0);
  const fdiv2 = (v: number) => Math.floor(v / 2);

  const gen = (x: number, y: number, ax: number, ay: number, bx: number, by: number): void => {
    const w = Math.abs(ax + ay);
    const h = Math.abs(bx + by);
    const dax = sgn(ax), day = sgn(ay);
    const dbx = sgn(bx), dby = sgn(by);
    if (h === 1) {
      for (let i = 0; i < w; i++) {
        emit(x, y);
        x += dax;
        y += day;
      }
      return;
    }
    if (w === 1) {
      for (let i = 0; i < h; i++) {
        emit(x, y);
        x += dbx;
        y += dby;
      }
      return;
    }
    let ax2 = fdiv2(ax), ay2 = fdiv2(ay);
    let bx2 = fdiv2(bx), by2 = fdiv2(by);
    const w2 = Math.abs(ax2 + ay2);
    const h2 = Math.abs(bx2 + by2);
    if (2 * w > 3 * h) {
      if (w2 % 2 && w > 2) {
        ax2 += dax;
        ay2 += day;
      }
      gen(x, y, ax2, ay2, bx, by);
      gen(x + ax2, y + ay2, ax - ax2, ay - ay2, bx, by);
    } else {
      if (h2 % 2 && h > 2) {
        bx2 += dbx;
        by2 += dby;
      }
      gen(x, y, bx2, by2, ax2, ay2);
      gen(x + bx2, y + by2, ax, ay, bx - bx2, by - by2);
      gen(x + (ax - dax) + (bx2 - dbx), y + (ay - day) + (by2 - dby), -bx2, -by2, -(ax - ax2), -(ay - ay2));
    }
  };

  if (width >= height) gen(0, 0, width, 0, 0, height);
  else gen(0, 0, 0, height, width, 0);
  if (n !== width * height) throw new Error('gilbert2d produced wrong number of cells');
  return out;
}
