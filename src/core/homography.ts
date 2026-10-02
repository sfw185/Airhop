/** 3x3 homography, row-major, mapping (x, y, 1) -> (u, v, w). */
export type Mat3 = Float64Array;

export type Pt = { x: number; y: number };

function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / M[i][i]);
}

function normalizer(pts: Pt[]): { T: Mat3; Tinv: Mat3 } {
  let mx = 0, my = 0;
  for (const p of pts) {
    mx += p.x;
    my += p.y;
  }
  mx /= pts.length;
  my /= pts.length;
  let d = 0;
  for (const p of pts) d += Math.hypot(p.x - mx, p.y - my);
  d /= pts.length;
  const s = d > 0 ? Math.SQRT2 / d : 1;
  const T = Float64Array.of(s, 0, -s * mx, 0, s, -s * my, 0, 0, 1);
  const Tinv = Float64Array.of(1 / s, 0, mx, 0, 1 / s, my, 0, 0, 1);
  return { T, Tinv };
}

export function mul3(a: Mat3, b: Mat3): Mat3 {
  const r = new Float64Array(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}

/** Least-squares homography (exact for 4 points) mapping src[i] -> dst[i]. */
export function fitHomography(src: Pt[], dst: Pt[]): Mat3 | null {
  if (src.length < 4 || src.length !== dst.length) return null;
  const ns = normalizer(src);
  const nd = normalizer(dst);
  const A: number[][] = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  const b = new Array<number>(8).fill(0);
  const acc = (row: number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      if (row[i] === 0) continue;
      for (let j = 0; j < 8; j++) A[i][j] += row[i] * row[j];
      b[i] += row[i] * rhs;
    }
  };
  for (let k = 0; k < src.length; k++) {
    const s = applyRaw(ns.T, src[k].x, src[k].y);
    const d = applyRaw(nd.T, dst[k].x, dst[k].y);
    acc([s.x, s.y, 1, 0, 0, 0, -s.x * d.x, -s.y * d.x], d.x);
    acc([0, 0, 0, s.x, s.y, 1, -s.x * d.y, -s.y * d.y], d.y);
  }
  const h = solve(A, b);
  if (!h) return null;
  const Hn = Float64Array.of(h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1);
  const H = mul3(mul3(nd.Tinv, Hn), ns.T);
  const s = H[8];
  if (!isFinite(s) || Math.abs(s) < 1e-15) return null;
  for (let i = 0; i < 9; i++) H[i] /= s;
  return H;
}

function applyRaw(H: Mat3, x: number, y: number): Pt {
  const w = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
}

export function apply(H: Mat3, x: number, y: number): Pt {
  return applyRaw(H, x, y);
}

export function invert3(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) return null;
  const r = Float64Array.of(A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d);
  for (let k = 0; k < 9; k++) r[k] /= det;
  return r;
}
