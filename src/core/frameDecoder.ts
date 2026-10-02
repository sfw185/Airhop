import { Binarizer, findFinders, toGray, type FinderCandidate } from './detector';
import { MAX_DIM, MIN_DIM, decodeFormatBits, type FrameFormat } from './format';
import { TILE_SCRAMBLE_SEED } from './frameEncoder';
import { apply, fitHomography, type Mat3, type Pt } from './homography';
import { finderCenter, finderModule, formatBitPoint, getLayout, type Layout } from './layout';
import { keystream } from './prng';
import { rsDecode } from './rs';
import { unpackTile, type TilePayload } from './tile';

export interface RGBAFrame {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

export type FrameStage = 'no-finders' | 'no-format' | 'decoded';

export interface FrameResult {
  stage: FrameStage;
  finders: FinderCandidate[];
  /** Image positions of the finder centres in TL, TR, BR, BL order. */
  corners?: Pt[];
  format?: FrameFormat;
  tilesTotal: number;
  tilesOk: number;
  /** Per-tile success flags. */
  tileOk?: Uint8Array;
  payloads: TilePayload[];
  alignFound: number;
  alignTotal: number;
  /** Mean RS corrections per decoded tile (a link-quality hint). */
  meanCorrections: number;
  ms: number;
  /** Per-stage timings in ms. */
  timings: Record<string, number>;
}

export interface DecoderOptions {
  /** Decision-directed refinement of the colour references. */
  refine?: boolean;
  /** Decision-feedback cancellation of colour bleed from neighbouring cells. */
  equalize?: boolean;
  /** Retry failed tiles with low-confidence bytes marked as erasures. */
  erasures?: boolean;
}

interface Located {
  format: FrameFormat;
  corners: Pt[];
  H0: Mat3;
  black: number;
  white: number;
  quadIndex: number;
  assignment: number;
  /** Corner (0..3) whose finder was not detected and was inferred from the other three. */
  inferred?: number;
}

function bilinearGray(g: Uint8Array, w: number, h: number, x: number, y: number): number {
  x -= 0.5;
  y -= 0.5;
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x > w - 1.001) x = w - 1.001;
  if (y > h - 1.001) y = h - 1.001;
  const x0 = x | 0;
  const y0 = y | 0;
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * w + x0;
  const a = g[i], b = g[i + 1], c = g[i + w], d = g[i + w + 1];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

function addBilinearRGB(img: Uint8ClampedArray | Uint8Array, w: number, h: number, x: number, y: number, out: Float32Array, o: number): void {
  x -= 0.5;
  y -= 0.5;
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x > w - 1.001) x = w - 1.001;
  if (y > h - 1.001) y = h - 1.001;
  const x0 = x | 0;
  const y0 = y | 0;
  const fx = x - x0;
  const fy = y - y0;
  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
  const p = (y0 * w + x0) * 4;
  const q = p + w * 4;
  out[o] += img[p] * w00 + img[p + 4] * w10 + img[q] * w01 + img[q + 4] * w11;
  out[o + 1] += img[p + 1] * w00 + img[p + 5] * w10 + img[q + 1] * w01 + img[q + 5] * w11;
  out[o + 2] += img[p + 2] * w00 + img[p + 6] * w10 + img[q + 2] * w01 + img[q + 6] * w11;
}

function cross(o: Pt, a: Pt, b: Pt): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Orders 4 points clockwise on screen (image y axis points down). */
function clockwise(pts: FinderCandidate[]): FinderCandidate[] {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  return pts.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
}

function candidateQuads(cands: FinderCandidate[], max = 6): FinderCandidate[][] {
  const top = cands.slice(0, 14);
  const quads: { q: FinderCandidate[]; area: number }[] = [];
  const n = top.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++) {
          const q = [top[a], top[b], top[c], top[d]];
          let mn = Infinity, mx = 0;
          for (const p of q) {
            mn = Math.min(mn, p.module);
            mx = Math.max(mx, p.module);
          }
          if (mx > mn * 2.5) continue;
          const o = clockwise(q);
          let convex = true;
          let area = 0;
          for (let i = 0; i < 4; i++) {
            const p0 = o[i], p1 = o[(i + 1) % 4], p2 = o[(i + 2) % 4];
            if (cross(p0, p1, p2) <= 0) convex = false;
            area += p0.x * p1.y - p1.x * p0.y;
          }
          if (!convex) continue;
          area = Math.abs(area) / 2;
          // The finders must be far apart compared with their size.
          if (area < (mx * 30) ** 2) continue;
          quads.push({ q: o, area });
        }
  quads.sort((x, y) => y.area - x.area);
  return quads.slice(0, max).map((x) => x.q);
}

/**
 * Quads built from three finders when the fourth was missed (glare, a finger, the frame edge).
 * The corner between the two shorter triangle sides is the one adjacent to both others, so the
 * missing corner completes the parallelogram opposite it. Returns clockwise quads plus the index
 * of the inferred point.
 */
function triangleQuads(cands: FinderCandidate[], max = 4): { q: FinderCandidate[]; inferred: number }[] {
  const top = cands.slice(0, 8);
  const out: { q: FinderCandidate[]; inferred: number; area: number }[] = [];
  for (let a = 0; a < top.length; a++)
    for (let b = a + 1; b < top.length; b++)
      for (let c = b + 1; c < top.length; c++) {
        const t = [top[a], top[b], top[c]];
        const mn = Math.min(...t.map((p) => p.module)), mx = Math.max(...t.map((p) => p.module));
        if (mx > mn * 2.5) continue;
        const d2 = (p: FinderCandidate, r: FinderCandidate) => (p.x - r.x) ** 2 + (p.y - r.y) ** 2;
        const sides = [d2(t[1], t[2]), d2(t[0], t[2]), d2(t[0], t[1])]; // side opposite vertex i
        const v = sides.indexOf(Math.max(...sides));
        const p1 = t[(v + 1) % 3], p2 = t[(v + 2) % 3], pv = t[v];
        const missing: FinderCandidate = { x: p1.x + p2.x - pv.x, y: p1.y + p2.y - pv.y, module: (p1.module + p2.module) / 2, count: 0 };
        const area = Math.abs((p1.x - pv.x) * (p2.y - pv.y) - (p1.y - pv.y) * (p2.x - pv.x));
        if (area < (mx * 30) ** 2) continue;
        const q = clockwise([pv, p1, missing, p2]);
        out.push({ q, inferred: q.indexOf(missing), area });
      }
  out.sort((x, y) => y.area - x.area);
  return out.slice(0, max);
}

function dimCandidates(est: number, preferred?: number): number[] {
  const out: number[] = [];
  const lo = Math.max(MIN_DIM, Math.floor((est * 0.88) / 8) * 8);
  const hi = Math.min(MAX_DIM, Math.ceil((est * 1.12) / 8) * 8);
  for (let d = lo; d <= hi; d += 8) out.push(d);
  out.sort((a, b) => Math.abs(a - est) - Math.abs(b - est));
  const res = out.slice(0, 4);
  if (preferred && preferred >= lo && preferred <= hi && !res.includes(preferred)) res.unshift(preferred);
  if (preferred && res.includes(preferred)) {
    res.splice(res.indexOf(preferred), 1);
    res.unshift(preferred);
  }
  return res;
}

const ALIGN_RING1: [number, number][] = [
  [-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1],
];
const ALIGN_RING2: [number, number][] = [];
for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) if (Math.max(Math.abs(x), Math.abs(y)) === 2) ALIGN_RING2.push([x, y]);

export class FrameDecoder {
  private bz = new Binarizer();
  private grayBuf = new Uint8Array(0);
  private last?: { format: FrameFormat; assignment: number };
  private ksCache = new Map<string, Uint8Array[]>();
  private mark: (name: string) => void = () => {};
  private cellRGB = new Float32Array(0);
  private cellSym = new Uint8Array(0);
  private cellConf = new Float32Array(0);
  private cellExp = new Float32Array(0);
  private cellEq = new Float32Array(0);
  private eqV = new Float32Array(0);
  private eqN4 = new Float32Array(0);
  private eqN8 = new Float32Array(0);
  readonly opts: Required<DecoderOptions>;

  constructor(opts: DecoderOptions = {}) {
    this.opts = { refine: true, equalize: true, erasures: true, ...opts };
  }

  decode(frame: RGBAFrame): FrameResult {
    const t0 = performance.now();
    const timings: Record<string, number> = {};
    let tp = t0;
    const mark = (name: string) => {
      const now = performance.now();
      timings[name] = now - tp;
      tp = now;
    };
    this.mark = mark;
    const { width: w, height: h } = frame;
    if (this.grayBuf.length !== w * h) this.grayBuf = new Uint8Array(w * h);
    const gray = toGray(frame.data, w, h, this.grayBuf);
    mark('gray');
    const bin = this.bz.run(gray);
    mark('binarize');
    const finders = findFinders(bin, w, h);
    mark('finders');
    const base: FrameResult = {
      stage: 'no-finders',
      finders,
      tilesTotal: 0,
      tilesOk: 0,
      payloads: [],
      alignFound: 0,
      alignTotal: 0,
      meanCorrections: 0,
      ms: 0,
      timings,
    };
    if (finders.length < 3) return { ...base, ms: performance.now() - t0 };
    const loc = this.locate(gray.data, w, h, finders);
    mark('locate');
    if (!loc) return { ...base, stage: 'no-format', ms: performance.now() - t0 };
    this.last = { format: loc.format, assignment: loc.assignment };
    const layout = getLayout(loc.format);
    const res = this.decodeGrid(frame, gray.data, layout, loc);
    return { ...base, ...res, stage: 'decoded', corners: loc.corners, format: loc.format, ms: performance.now() - t0 };
  }

  private locate(g: Uint8Array, w: number, h: number, finders: FinderCandidate[]): Located | null {
    const quads = candidateQuads(finders);
    for (let qi = 0; qi < quads.length; qi++) {
      const loc = this.tryQuad(g, w, h, quads[qi], qi);
      if (loc) return loc;
    }
    if (finders.length >= 3) {
      const tris = triangleQuads(finders);
      for (let ti = 0; ti < tris.length; ti++) {
        const loc = this.tryQuad(g, w, h, tris[ti].q, quads.length + ti, tris[ti].inferred);
        if (loc) return loc;
      }
    }
    return null;
  }

  /** Tries every corner assignment and grid size for a clockwise quad of finder centres. */
  private tryQuad(g: Uint8Array, w: number, h: number, q: FinderCandidate[], qi: number, inferredQ?: number): Located | null {
    const assignments: number[] = [];
    const lastA = this.last?.assignment;
    if (lastA !== undefined) assignments.push(lastA);
    for (let a = 0; a < 8; a++) if (a !== lastA) assignments.push(a);
    for (const a of assignments) {
      const rot = a & 3;
      const mirror = a >= 4;
      // corners in TL, TR, BR, BL order
      const c: FinderCandidate[] = [];
      for (let k = 0; k < 4; k++) c.push(q[(rot + (mirror ? -k + 4 : k)) % 4]);
      const inferred = inferredQ === undefined ? undefined : c.indexOf(q[inferredQ]);
      // Distance between finder centres in finder modules.
      const dist = (p: FinderCandidate, r: FinderCandidate) => Math.hypot(p.x - r.x, p.y - r.y) / ((p.module + r.module) / 2);
      const dw = (dist(c[0], c[1]) + dist(c[3], c[2])) / 2;
      const dh = (dist(c[0], c[3]) + dist(c[1], c[2])) / 2;
      for (const fm of [1, 2]) {
        const ws = dimCandidates(fm * (dw + 7), this.last?.format.width);
        const hs = dimCandidates(fm * (dh + 7), this.last?.format.height);
        for (const W of ws) {
          for (const H of hs) {
            if (finderModule(W, H) !== fm) continue;
            const src = [0, 1, 2, 3].map((k) => finderCenter(W, H, fm, k));
            const H0 = fitHomography(src, c);
            if (!H0) continue;
            const f = this.readFormat(g, w, h, H0, W, H, fm, inferred);
            if (f && f.format.width === W && f.format.height === H) {
              return { format: f.format, corners: c.map((p) => ({ x: p.x, y: p.y })), H0, black: f.black, white: f.white, quadIndex: qi, assignment: a, inferred };
            }
          }
        }
      }
    }
    return null;
  }

  private readFormat(g: Uint8Array, w: number, h: number, H0: Mat3, W: number, H: number, fm: number, skip?: number): { format: FrameFormat; black: number; white: number } | null {
    const at = (gx: number, gy: number) => {
      const p = apply(H0, gx, gy);
      return bilinearGray(g, w, h, p.x, p.y);
    };
    let blackSum = 0, whiteSum = 0, used = 0;
    let found: FrameFormat | null = null;
    const votes = new Int32Array(32);
    const thresholds: number[] = [];
    for (let corner = 0; corner < 4; corner++) {
      const fc = finderCenter(W, H, fm, corner);
      const d = 2 * fm;
      const black = at(fc.x, fc.y);
      const white = (at(fc.x + d, fc.y) + at(fc.x - d, fc.y) + at(fc.x, fc.y + d) + at(fc.x, fc.y - d)) / 4;
      thresholds.push((black + white) / 2);
      if (corner === skip) continue;
      blackSum += black;
      whiteSum += white;
      used++;
    }
    if (whiteSum - blackSum < used * 20) return null;
    if (skip !== undefined) thresholds[skip] = (blackSum + whiteSum) / (2 * used);
    const bitsPerCorner: Uint8Array[] = [];
    for (let corner = 0; corner < 4; corner++) {
      const bits = new Uint8Array(32);
      for (let b = 0; b < 32; b++) {
        const p = formatBitPoint(W, H, fm, corner, b);
        bits[b] = at(p.x, p.y) < thresholds[corner] ? 1 : 0;
        votes[b] += bits[b];
      }
      bitsPerCorner.push(bits);
      if (!found) found = decodeFormatBits(bits, corner);
    }
    if (!found) {
      // Majority vote across corners can recover from a single bad copy per bit. Each copy has
      // its own CRC salt, so vote on the data bits and re-check against each corner's CRC.
      const maj = new Uint8Array(32);
      for (let b = 0; b < 16; b++) maj[b] = votes[b] >= 2 ? 1 : 0;
      for (let corner = 0; corner < 4 && !found; corner++) {
        maj.set(bitsPerCorner[corner].subarray(16), 16);
        found = decodeFormatBits(maj, corner);
      }
    }
    if (!found) return null;
    return { format: found, black: blackSum / used, white: whiteSum / used };
  }

  private refineNodes(g: Uint8Array, w: number, h: number, layout: Layout, loc: Located): { pos: Pt[]; found: number; total: number } {
    const { nx, ny, nodes } = layout;
    const H0 = loc.H0;
    const N = nodes.length;
    const pos: Pt[] = new Array(N);
    const disp: (Pt | null)[] = new Array(N).fill(null);
    const contrast = Math.max(20, loc.white - loc.black);
    const cornerIdx = [0, nx - 1, N - 1, N - nx];
    for (let k = 0; k < 4; k++) {
      if (k === loc.inferred) continue;
      pos[cornerIdx[k]] = loc.corners[k];
      disp[cornerIdx[k]] = { x: 0, y: 0 };
    }
    const order: number[] = [];
    for (let idx = 0; idx < N; idx++) if (nodes[idx].kind === 'align') order.push(idx);
    const latDist = (idx: number) => {
      const i = idx % nx, j = (idx / nx) | 0;
      return Math.min(Math.max(i, j), Math.max(nx - 1 - i, j), Math.max(i, ny - 1 - j), Math.max(nx - 1 - i, ny - 1 - j));
    };
    order.sort((a, b) => latDist(a) - latDist(b));

    const neighbourDisp = (idx: number, radius: number): Pt | null => {
      const i = idx % nx, j = (idx / nx) | 0;
      let sx = 0, sy = 0, sw = 0;
      for (let dj = -radius; dj <= radius; dj++)
        for (let di = -radius; di <= radius; di++) {
          if (!di && !dj) continue;
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
          const d = disp[jj * nx + ii];
          if (!d) continue;
          const wgt = 1 / (di * di + dj * dj);
          sx += d.x * wgt;
          sy += d.y * wgt;
          sw += wgt;
        }
      return sw > 0 ? { x: sx / sw, y: sy / sw } : null;
    };

    let found = 0;
    for (const idx of order) {
      const node = nodes[idx];
      const base = apply(H0, node.gx, node.gy);
      const nd = neighbourDisp(idx, 1) ?? neighbourDisp(idx, 2) ?? { x: 0, y: 0 };
      const pred = { x: base.x + nd.x, y: base.y + nd.y };
      const px = apply(H0, node.gx + 1, node.gy);
      const py = apply(H0, node.gx, node.gy + 1);
      const ex = { x: px.x - base.x, y: px.y - base.y };
      const ey = { x: py.x - base.x, y: py.y - base.y };
      const cell = Math.max(Math.hypot(ex.x, ex.y), Math.hypot(ey.x, ey.y));
      const score = (cx: number, cy: number) => {
        let r1 = 0, r2 = 0;
        for (const [a, b] of ALIGN_RING1) r1 += bilinearGray(g, w, h, cx + a * ex.x + b * ey.x, cy + a * ex.y + b * ey.y);
        for (const [a, b] of ALIGN_RING2) r2 += bilinearGray(g, w, h, cx + a * ex.x + b * ey.x, cy + a * ex.y + b * ey.y);
        const c0 = bilinearGray(g, w, h, cx, cy);
        return (r1 / ALIGN_RING1.length - (c0 + r2 / ALIGN_RING2.length) / 2) / contrast;
      };
      const R = 2 * cell;
      const step = Math.max(1, cell / 3);
      let best = -Infinity, bx = pred.x, by = pred.y;
      for (let dy = -R; dy <= R; dy += step)
        for (let dx = -R; dx <= R; dx += step) {
          const s = score(pred.x + dx, pred.y + dy);
          if (s > best) {
            best = s;
            bx = pred.x + dx;
            by = pred.y + dy;
          }
        }
      // Local refinement at sub-step resolution.
      let st = step / 2;
      while (st >= 0.25) {
        let improved = true;
        while (improved) {
          improved = false;
          for (const [dx, dy] of [[st, 0], [-st, 0], [0, st], [0, -st]]) {
            const s = score(bx + dx, by + dy);
            if (s > best) {
              best = s;
              bx += dx;
              by += dy;
              improved = true;
            }
          }
        }
        st /= 2;
      }
      if (best > 0.3) {
        pos[idx] = { x: bx, y: by };
        disp[idx] = { x: bx - base.x, y: by - base.y };
        found++;
      }
    }
    if (loc.inferred !== undefined) {
      // Find the missed finder near where its neighbours put it: dark centre, light ring at two
      // modules, dark ring at three.
      const idx = cornerIdx[loc.inferred];
      const node = nodes[idx];
      const fm = layout.fm;
      const base = apply(H0, node.gx, node.gy);
      const nd = neighbourDisp(idx, 1) ?? neighbourDisp(idx, 2) ?? { x: 0, y: 0 };
      const pred = { x: base.x + nd.x, y: base.y + nd.y };
      const px = apply(H0, node.gx + fm, node.gy), py = apply(H0, node.gx, node.gy + fm);
      const ex = { x: px.x - base.x, y: px.y - base.y }, ey = { x: py.x - base.x, y: py.y - base.y };
      const mod = Math.max(Math.hypot(ex.x, ex.y), Math.hypot(ey.x, ey.y));
      const score = (cx: number, cy: number) => {
        let light = 0, dark = 0;
        for (const [a, b] of ALIGN_RING1) {
          light += bilinearGray(g, w, h, cx + 2 * (a * ex.x + b * ey.x), cy + 2 * (a * ex.y + b * ey.y));
          dark += bilinearGray(g, w, h, cx + 3 * (a * ex.x + b * ey.x), cy + 3 * (a * ex.y + b * ey.y));
        }
        const c0 = bilinearGray(g, w, h, cx, cy);
        return (light / 8 - (c0 + dark / 8) / 2) / contrast;
      };
      const R = 3 * mod;
      let best = -Infinity, bx = pred.x, by = pred.y;
      for (let st = Math.max(1, mod / 3), first = true; st >= 0.25; st /= 2, first = false) {
        const r = first ? R : st * 2;
        const cx0 = bx, cy0 = by;
        for (let dy = -r; dy <= r; dy += st)
          for (let dx = -r; dx <= r; dx += st) {
            const sc = score(cx0 + dx, cy0 + dy);
            if (sc > best) {
              best = sc;
              bx = cx0 + dx;
              by = cy0 + dy;
            }
          }
      }
      pos[idx] = best > 0.3 ? { x: bx, y: by } : pred;
      loc.corners[loc.inferred] = pos[idx];
    }
    for (let idx = 0; idx < N; idx++) {
      if (pos[idx]) continue;
      const node = nodes[idx];
      const base = apply(H0, node.gx, node.gy);
      const nd = neighbourDisp(idx, 1) ?? neighbourDisp(idx, 2) ?? { x: 0, y: 0 };
      pos[idx] = { x: base.x + nd.x, y: base.y + nd.y };
    }
    return { pos, found, total: order.length };
  }

  /**
   * Decision-feedback equaliser for optical blur. Models each observed cell as its expected
   * colour plus leakage from its 4-neighbours (b4) and diagonal neighbours (b8), relative to the
   * mean colour. Fits b4, b8 by least squares against the current decisions and writes
   * bleed-corrected samples to `out`.
   */
  private equalize(layout: Layout, rgb: Float32Array, exp: Float32Array, out: Float32Array): void {
    const { W, H, role } = layout;
    const n = W * H;
    if (this.eqV.length !== n * 3) {
      this.eqV = new Float32Array(n * 3);
      this.eqN4 = new Float32Array(n * 3);
      this.eqN8 = new Float32Array(n * 3);
    }
    const V = this.eqV, N4 = this.eqN4, N8 = this.eqN8;
    // Neighbour value: decided colour for data cells, the observation for everything else,
    // relative to the mean data colour (so cells outside the grid contribute nothing).
    let m0 = 0, m1 = 0, m2 = 0, nData = 0;
    for (let i = 0; i < n; i++) {
      if (role[i] !== 0) continue;
      m0 += exp[i * 3];
      m1 += exp[i * 3 + 1];
      m2 += exp[i * 3 + 2];
      nData++;
    }
    if (!nData) return;
    m0 /= nData;
    m1 /= nData;
    m2 /= nData;
    for (let i = 0; i < n; i++) {
      const src = role[i] === 0 ? exp : rgb;
      V[i * 3] = src[i * 3] - m0;
      V[i * 3 + 1] = src[i * 3 + 1] - m1;
      V[i * 3 + 2] = src[i * 3 + 2] - m2;
    }
    let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
    for (let y = 0; y < H; y++) {
      const up = y > 0, down = y < H - 1;
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (role[i] !== 0) continue;
        const left = x > 0, right = x < W - 1;
        for (let ch = 0; ch < 3; ch++) {
          const o = i * 3 + ch;
          let s4 = 0, s8 = 0;
          if (left) s4 += V[o - 3];
          if (right) s4 += V[o + 3];
          if (up) {
            s4 += V[o - W * 3];
            if (left) s8 += V[o - W * 3 - 3];
            if (right) s8 += V[o - W * 3 + 3];
          }
          if (down) {
            s4 += V[o + W * 3];
            if (left) s8 += V[o + W * 3 - 3];
            if (right) s8 += V[o + W * 3 + 3];
          }
          N4[o] = s4;
          N8[o] = s8;
          const r = rgb[o] - exp[o];
          a11 += s4 * s4;
          a12 += s4 * s8;
          a22 += s8 * s8;
          b1 += r * s4;
          b2 += r * s8;
        }
      }
    }
    const det = a11 * a22 - a12 * a12;
    let beta4 = 0, beta8 = 0;
    if (Math.abs(det) > 1e-9) {
      beta4 = (b1 * a22 - b2 * a12) / det;
      beta8 = (a11 * b2 - a12 * b1) / det;
    }
    beta4 = Math.min(0.2, Math.max(0, beta4));
    beta8 = Math.min(0.1, Math.max(0, beta8));
    for (let i = 0; i < n; i++) {
      if (role[i] !== 0) continue;
      for (let ch = 0; ch < 3; ch++) {
        const o = i * 3 + ch;
        out[o] = rgb[o] - beta4 * N4[o] - beta8 * N8[o];
      }
    }
    this.lastBeta = [beta4, beta8];
  }

  /** Bleed coefficients fitted on the last frame (diagnostics). */
  lastBeta: [number, number] = [0, 0];

  private keystreams(layout: Layout): Uint8Array[] {
    let ks = this.ksCache.get(layout.key);
    if (!ks) {
      ks = layout.tiles.map((t, i) => keystream(TILE_SCRAMBLE_SEED + i, t.n));
      this.ksCache.set(layout.key, ks);
    }
    return ks;
  }

  private decodeGrid(frame: RGBAFrame, g: Uint8Array, layout: Layout, loc: Located): Partial<FrameResult> {
    const { width: w, height: h, data: img } = frame;
    const { W, nx, ny, nodes, palette } = layout;
    const P = palette.length;
    const { pos, found, total } = this.refineNodes(g, w, h, layout, loc);
    this.mark('align');

    // Per-quad homographies.
    const nq = (nx - 1) * (ny - 1);
    const quadH: Mat3[] = new Array(nq);
    const quadEx = new Float32Array(nq * 4);
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const ids = [j * nx + i, j * nx + i + 1, (j + 1) * nx + i + 1, (j + 1) * nx + i];
        const src = ids.map((k) => ({ x: nodes[k].gx, y: nodes[k].gy }));
        const dst = ids.map((k) => pos[k]);
        const Hq = fitHomography(src, dst) ?? loc.H0;
        const q = j * (nx - 1) + i;
        quadH[q] = Hq;
        const cx = (src[0].x + src[1].x) / 2, cy = (src[0].y + src[3].y) / 2;
        const c = apply(Hq, cx, cy), a = apply(Hq, cx + 1, cy), b = apply(Hq, cx, cy + 1);
        quadEx[q * 4] = a.x - c.x;
        quadEx[q * 4 + 1] = a.y - c.y;
        quadEx[q * 4 + 2] = b.x - c.x;
        quadEx[q * 4 + 3] = b.y - c.y;
      }
    }

    const sampleCell = (cell: number, out: Float32Array, o: number) => {
      const q = layout.cellQuad[cell];
      const Hq = quadH[q];
      const gx = (cell % W) + 0.5;
      const gy = ((cell / W) | 0) + 0.5;
      const wq = Hq[6] * gx + Hq[7] * gy + Hq[8];
      const u = (Hq[0] * gx + Hq[1] * gy + Hq[2]) / wq;
      const v = (Hq[3] * gx + Hq[4] * gy + Hq[5]) / wq;
      const exx = quadEx[q * 4] * 0.2, exy = quadEx[q * 4 + 1] * 0.2;
      const eyx = quadEx[q * 4 + 2] * 0.2, eyy = quadEx[q * 4 + 3] * 0.2;
      out[o] = out[o + 1] = out[o + 2] = 0;
      addBilinearRGB(img, w, h, u, v, out, o);
      addBilinearRGB(img, w, h, u + exx, v + exy, out, o);
      addBilinearRGB(img, w, h, u - exx, v - exy, out, o);
      addBilinearRGB(img, w, h, u + eyx, v + eyy, out, o);
      addBilinearRGB(img, w, h, u - eyx, v - eyy, out, o);
      out[o] *= 0.2;
      out[o + 1] *= 0.2;
      out[o + 2] *= 0.2;
    };

    // Reference colours per node.
    const N = nodes.length;
    const ref = new Float32Array(N * P * 3);
    const refN = new Float32Array(N * P);
    const tmp = new Float32Array(3);
    for (let k = 0; k < N; k++) {
      for (const r of nodes[k].refs) {
        sampleCell(r.cell, tmp, 0);
        const o = (k * P + r.color) * 3;
        ref[o] += tmp[0];
        ref[o + 1] += tmp[1];
        ref[o + 2] += tmp[2];
        refN[k * P + r.color]++;
      }
    }
    for (let k = 0; k < N * P; k++) {
      if (refN[k] > 0) {
        ref[k * 3] /= refN[k];
        ref[k * 3 + 1] /= refN[k];
        ref[k * 3 + 2] /= refN[k];
      }
    }
    // Fill nodes lacking references from their neighbours (repeat until complete).
    for (let pass = 0; pass < nx + ny; pass++) {
      let missing = 0;
      for (let k = 0; k < N; k++) {
        for (let c = 0; c < P; c++) {
          if (refN[k * P + c] > 0) continue;
          const i = k % nx, j = (k / nx) | 0;
          let s0 = 0, s1 = 0, s2 = 0, cnt = 0;
          for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
            const kk = jj * nx + ii;
            if (refN[kk * P + c] <= 0) continue;
            const o = (kk * P + c) * 3;
            s0 += ref[o];
            s1 += ref[o + 1];
            s2 += ref[o + 2];
            cnt++;
          }
          if (cnt) {
            const o = (k * P + c) * 3;
            ref[o] = s0 / cnt;
            ref[o + 1] = s1 / cnt;
            ref[o + 2] = s2 / cnt;
            refN[k * P + c] = -1; // filled (negative marks synthetic)
          } else missing++;
        }
      }
      for (let k = 0; k < N * P; k++) if (refN[k] < 0) refN[k] = 0.5;
      if (!missing) break;
    }

    this.mark('refs');
    // Sample every tile cell once into row-major buffers indexed by cell.
    const tiles = layout.tiles;
    const { H: GH, role } = layout;
    const nCells = W * GH;
    if (this.cellRGB.length !== nCells * 3) {
      this.cellRGB = new Float32Array(nCells * 3);
      this.cellSym = new Uint8Array(nCells);
      this.cellConf = new Float32Array(nCells);
      this.cellExp = new Float32Array(nCells * 3);
      this.cellEq = new Float32Array(nCells * 3);
    }
    const rgb = this.cellRGB, sym = this.cellSym, conf = this.cellConf, exp = this.cellExp;
    for (const t of tiles) for (let c = 0; c < t.cells.length; c++) sampleCell(t.cells[c], rgb, t.cells[c] * 3);
    if (this.opts.equalize) for (const c of layout.contextCells) sampleCell(c, rgb, c * 3);
    this.mark('sample');

    // Nearest expected colour, where expected colours are bilinearly interpolated between the
    // four lattice nodes around each cell. Work row by row so the vertical interpolation is done
    // once per quad span and only the horizontal one per cell.
    const nqx = nx - 1;
    const P3 = P * 3;
    const E0 = new Float32Array(P3), E1 = new Float32Array(P3);
    const colStart = layout.quadColStart;
    const classify = (src: Float32Array) => {
      for (let y = 0; y < GH; y++) {
        const qj = (layout.cellQuad[y * W] / nqx) | 0;
        const u = layout.cellU[y * W];
        for (let i = 0; i < nqx; i++) {
          const k00 = (qj * nx + i) * P3, k10 = k00 + P3, k01 = k00 + nx * P3, k11 = k01 + P3;
          for (let p = 0; p < P3; p++) {
            const a = ref[k00 + p] + (ref[k01 + p] - ref[k00 + p]) * u;
            const b = ref[k10 + p] + (ref[k11 + p] - ref[k10 + p]) * u;
            E0[p] = a;
            E1[p] = b - a;
          }
          const xEnd = i + 1 < nqx ? colStart[i + 1] : W;
          for (let x = colStart[i]; x < xEnd; x++) {
            const cell = y * W + x;
            if (role[cell] !== 0 /* Role.Data */) continue;
            const t = layout.cellT[cell];
            const s0 = src[cell * 3], s1 = src[cell * 3 + 1], s2 = src[cell * 3 + 2];
            let b1 = Infinity, b2 = Infinity, bi = 0;
            for (let p = 0, q = 0; p < P; p++, q += 3) {
              const d0 = s0 - (E0[q] + E1[q] * t);
              const d1 = s1 - (E0[q + 1] + E1[q + 1] * t);
              const d2 = s2 - (E0[q + 2] + E1[q + 2] * t);
              const d = d0 * d0 + d1 * d1 + d2 * d2;
              if (d < b1) {
                b2 = b1;
                b1 = d;
                bi = p;
              } else if (d < b2) b2 = d;
            }
            sym[cell] = bi;
            conf[cell] = Math.sqrt(b2) - Math.sqrt(b1);
            const q = bi * 3;
            exp[cell * 3] = E0[q] + E1[q] * t;
            exp[cell * 3 + 1] = E0[q + 1] + E1[q + 1] * t;
            exp[cell * 3 + 2] = E0[q + 2] + E1[q + 2] * t;
          }
        }
      }
    };
    classify(rgb);
    this.mark('classify1');

    if (this.opts.refine) {
      // Decision-directed update: blend each node's reference means with the means of nearby
      // cells classified as that colour (bilinear weights), then classify again.
      const acc = new Float32Array(N * P3);
      const accW = new Float32Array(N * P);
      for (let y = 0; y < GH; y++) {
        const qj = (layout.cellQuad[y * W] / nqx) | 0;
        const u = layout.cellU[y * W];
        for (let i = 0; i < nqx; i++) {
          const k00 = qj * nx + i;
          const xEnd = i + 1 < nqx ? colStart[i + 1] : W;
          for (let x = colStart[i]; x < xEnd; x++) {
            const cell = y * W + x;
            if (role[cell] !== 0) continue;
            const t = layout.cellT[cell];
            const c = sym[cell];
            const s0 = rgb[cell * 3], s1 = rgb[cell * 3 + 1], s2 = rgb[cell * 3 + 2];
            // Weights for the four surrounding nodes (k00, k00+1, k00+nx, k00+nx+1).
            for (let z = 0; z < 4; z++) {
              const wz = (z & 1 ? t : 1 - t) * (z & 2 ? u : 1 - u);
              if (wz < 0.05) continue;
              const a = (k00 + (z & 1) + (z & 2 ? nx : 0)) * P + c;
              acc[a * 3] += s0 * wz;
              acc[a * 3 + 1] += s1 * wz;
              acc[a * 3 + 2] += s2 * wz;
              accW[a] += wz;
            }
          }
        }
      }
      for (let a = 0; a < N * P; a++) {
        const rw = Math.max(refN[a], 0) * 2;
        const tw = rw + accW[a];
        if (tw <= 0 || accW[a] < 3) continue;
        for (let ch = 0; ch < 3; ch++) ref[a * 3 + ch] = (ref[a * 3 + ch] * rw + acc[a * 3 + ch]) / tw;
      }
      this.mark('refine');
      classify(rgb);
    }

    if (this.opts.equalize) {
      this.equalize(layout, rgb, exp, this.cellEq);
      this.mark('equalize');
      classify(this.cellEq);
    }

    this.mark('classify');
    // Tiles -> bytes -> RS.
    const bpc = layout.bpc;
    const ks = this.keystreams(layout);
    const tileOk = new Uint8Array(tiles.length);
    const payloads: TilePayload[] = [];
    let corrections = 0;
    for (let t = 0; t < tiles.length; t++) {
      const tile = tiles[t];
      const n = tile.n;
      const cw = new Uint8Array(n);
      const byteConf = new Float32Array(n).fill(Infinity);
      let bitPos = 0;
      for (let c = 0; c < tile.cells.length && bitPos < n * 8; c++) {
        const cell = tile.cells[c];
        const v = sym[cell];
        const cf = conf[cell];
        for (let b = bpc - 1; b >= 0 && bitPos < n * 8; b--, bitPos++) {
          const byte = bitPos >> 3;
          if ((v >> b) & 1) cw[byte] |= 1 << (7 - (bitPos & 7));
          if (cf < byteConf[byte]) byteConf[byte] = cf;
        }
      }
      const k = ks[t];
      for (let i = 0; i < n; i++) cw[i] ^= k[i];
      let res = rsDecode(cw, tile.nsym);
      if (!res && this.opts.erasures) {
        const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => byteConf[a] - byteConf[b]);
        for (const frac of [0.5, 0.75, 0.9]) {
          res = rsDecode(cw, tile.nsym, order.slice(0, Math.floor(tile.nsym * frac)));
          if (res) break;
        }
      }
      if (!res) continue;
      const p = unpackTile(res.data);
      if (!p) continue;
      tileOk[t] = 1;
      corrections += res.corrected;
      payloads.push(p);
    }
    this.mark('rs');
    return {
      tilesTotal: tiles.length,
      tilesOk: payloads.length,
      tileOk,
      payloads,
      alignFound: found,
      alignTotal: total,
      meanCorrections: payloads.length ? corrections / payloads.length : 0,
    };
  }
}

