import {
  ECC_PARITY,
  PALETTES,
  SYMBOL_SIZE,
  TILE_DATA,
  encodeFormatBits,
  formatKey,
  validateFormat,
  type FrameFormat,
  type RGB,
} from './format';
import { gilbert2d } from './gilbert';
import { mulberry32 } from './prng';

/*
 * Frame geometry (all coordinates in cells, origin top-left). `fm` is the finder module size in
 * cells: 1 for small grids, 2 for large ones, so the finders stay detectable when cells shrink
 * to a few camera pixels.
 *
 *  - Four 7x7-module QR-style finder patterns in the corners, each with a one-module separator.
 *  - Next to each finder, a strip of 16x3 modules (rotated pinwheel-style around the frame):
 *    two rows of format bits (32 bits: 16 data + CRC-16 salted by corner) and one row of
 *    palette reference cells.
 *  - A lattice of 5x5-cell alignment patterns (spacing <= ALIGN_SPACING) whose centres, together
 *    with the finder centres, drive a piecewise perspective transform. Each alignment pattern is
 *    ringed by 24 palette reference cells for local colour calibration.
 *  - All remaining cells carry data. They are ordered along a generalised Hilbert curve and cut
 *    into tiles; each tile holds exactly one Reed-Solomon codeword (one fountain-coded packet).
 */

export const enum Role {
  Data = 0,
  Finder = 1,
  Separator = 2,
  Format = 3,
  Ref = 4,
  Align = 5,
  Filler = 6,
}

export const STRIP_LEN = 16;
export const ALIGN_SPACING = 32;

/** Finder module size in cells for a given grid. */
export function finderModule(W: number, H: number): number {
  return Math.max(W, H) >= 176 ? 2 : 1;
}

/**
 * Grid coordinate of a point in strip space for corner 0=TL, 1=TR, 2=BR, 3=BL.
 * su runs along the strip [0, 16*fm), sv across it [0, 3*fm): rows sv < 2*fm hold format bits,
 * the last fm rows hold palette references.
 */
export function stripPoint(W: number, H: number, fm: number, corner: number, su: number, sv: number): { x: number; y: number } {
  const o = 8 * fm;
  switch (corner) {
    case 0:
      return { x: o + su, y: sv };
    case 1:
      return { x: W - sv, y: o + su };
    case 2:
      return { x: W - o - su, y: H - sv };
    default:
      return { x: sv, y: H - o - su };
  }
}

/** Centre (grid coordinates) of format bit `b` for a corner. */
export function formatBitPoint(W: number, H: number, fm: number, corner: number, b: number): { x: number; y: number } {
  const u = b % STRIP_LEN;
  const v = Math.floor(b / STRIP_LEN);
  return stripPoint(W, H, fm, corner, (u + 0.5) * fm, (v + 0.5) * fm);
}

/** Finder centre (grid coordinates) for corner 0=TL, 1=TR, 2=BR, 3=BL. */
export function finderCenter(W: number, H: number, fm: number, corner: number): { x: number; y: number } {
  const c = 3.5 * fm;
  return {
    x: corner === 1 || corner === 2 ? W - c : c,
    y: corner === 2 || corner === 3 ? H - c : c,
  };
}

export interface LatticeNode {
  /** Grid coordinate of the node centre. */
  gx: number;
  gy: number;
  kind: 'finder' | 'align' | 'virtual';
  /** Reference cells: cell index and palette index. */
  refs: { cell: number; color: number }[];
}

export interface Tile {
  /** Cell indices in bit order. */
  cells: Int32Array;
  /** Codeword length in bytes. */
  n: number;
  nsym: number;
}

export class Layout {
  readonly format: FrameFormat;
  readonly key: string;
  readonly W: number;
  readonly H: number;
  readonly fm: number;
  readonly bpc: number;
  readonly palette: readonly RGB[];
  readonly role: Uint8Array;
  /** RGB for every non-data cell (data cells are zero). */
  readonly template: Uint8Array;
  /** Lattice node centre coordinates (grid units). */
  readonly latX: number[];
  readonly latY: number[];
  /** Row-major nodes, ny rows of nx. */
  readonly nodes: LatticeNode[];
  readonly tiles: Tile[];
  /** For every cell: quad index (into (nx-1)*(ny-1)) and bilinear weights within it. */
  readonly cellQuad: Int32Array;
  readonly cellT: Float32Array;
  readonly cellU: Float32Array;
  /** First cell column of each lattice quad column, plus W as a sentinel (length nx). */
  readonly quadColStart: Int32Array;
  /** Non-data cells that touch a data cell (sampled as context for the equaliser). */
  readonly contextCells: Int32Array;

  constructor(format: FrameFormat) {
    validateFormat(format);
    this.format = { ...format };
    this.key = formatKey(format);
    const W = (this.W = format.width);
    const H = (this.H = format.height);
    const fm = (this.fm = finderModule(W, H));
    this.bpc = format.bpc;
    this.palette = PALETTES[format.bpc];
    const P = this.palette.length;
    const role = (this.role = new Uint8Array(W * H));
    const tpl = (this.template = new Uint8Array(W * H * 3));
    const set = (x: number, y: number, r: Role, c: RGB) => {
      const i = y * W + x;
      role[i] = r;
      tpl[i * 3] = c[0];
      tpl[i * 3 + 1] = c[1];
      tpl[i * 3 + 2] = c[2];
    };
    const black: RGB = [0, 0, 0];
    const white: RGB = [255, 255, 255];

    // Finders + separators: an 8x8-module block in each corner, finder at the outer corner.
    const B = 8 * fm;
    for (let c = 0; c < 4; c++) {
      const ox = c === 1 || c === 2 ? W - B : 0;
      const oy = c === 2 || c === 3 ? H - B : 0;
      const fx = c === 1 || c === 2 ? ox + fm : ox;
      const fy = c === 2 || c === 3 ? oy + fm : oy;
      for (let y = 0; y < B; y++) {
        for (let x = 0; x < B; x++) {
          const gx = ox + x;
          const gy = oy + y;
          const mx = Math.floor((gx - fx) / fm);
          const my = Math.floor((gy - fy) / fm);
          if (gx >= fx && gy >= fy && mx < 7 && my < 7) {
            const d = Math.max(Math.abs(mx - 3), Math.abs(my - 3));
            set(gx, gy, Role.Finder, d === 3 || d <= 1 ? black : white);
          } else {
            set(gx, gy, Role.Separator, white);
          }
        }
      }
    }

    // Format strips and strip references (pinwheel).
    const stripRefs: { cell: number; color: number }[][] = [];
    for (let c = 0; c < 4; c++) {
      const fbits = encodeFormatBits(format, c);
      for (let su = 0; su < STRIP_LEN * fm; su++) {
        for (let sv = 0; sv < 2 * fm; sv++) {
          const p = stripPoint(W, H, fm, c, su + 0.5, sv + 0.5);
          const b = Math.floor(sv / fm) * STRIP_LEN + Math.floor(su / fm);
          set(Math.floor(p.x), Math.floor(p.y), Role.Format, fbits[b] ? black : white);
        }
      }
      const refs: { cell: number; color: number }[] = [];
      for (let su = 0; su < STRIP_LEN * fm; su++) {
        for (let sv = 2 * fm; sv < 3 * fm; sv++) {
          const p = stripPoint(W, H, fm, c, su + 0.5, sv + 0.5);
          const x = Math.floor(p.x), y = Math.floor(p.y);
          const color = (su + sv) % P;
          set(x, y, Role.Ref, this.palette[color]);
          refs.push({ cell: y * W + x, color });
        }
      }
      stripRefs.push(refs);
    }

    // Lattice: node centres from finder centre to finder centre, interior nodes on cell centres.
    const lattice = (dim: number) => {
      const a = 3.5 * fm;
      const b = dim - 3.5 * fm;
      const n = Math.max(2, Math.ceil((b - a) / ALIGN_SPACING) + 1);
      const out: number[] = [a];
      for (let i = 1; i < n - 1; i++) out.push(Math.floor(a + (i * (b - a)) / (n - 1)) + 0.5);
      out.push(b);
      return out;
    };
    this.latX = lattice(W);
    this.latY = lattice(H);
    const nx = this.latX.length;
    const ny = this.latY.length;
    this.nodes = [];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const node: LatticeNode = { gx: this.latX[i], gy: this.latY[j], kind: 'virtual', refs: [] };
        const isCorner = (i === 0 || i === nx - 1) && (j === 0 || j === ny - 1);
        if (isCorner) {
          node.kind = 'finder';
          const corner = j === 0 ? (i === 0 ? 0 : 1) : i === 0 ? 3 : 2;
          node.refs = stripRefs[corner];
        } else {
          const cx = Math.floor(node.gx);
          const cy = Math.floor(node.gy);
          let ok = cx - 3 >= 0 && cy - 3 >= 0 && cx + 3 < W && cy + 3 < H;
          for (let y = cy - 3; ok && y <= cy + 3; y++) {
            for (let x = cx - 3; x <= cx + 3; x++) {
              if (role[y * W + x] !== Role.Data) {
                ok = false;
                break;
              }
            }
          }
          if (ok) {
            node.kind = 'align';
            // Edge rows/columns share the finder coordinate, which is not a cell centre when fm=2.
            node.gx = cx + 0.5;
            node.gy = cy + 0.5;
            // Walk the 7x7 border clockwise so neighbouring references get different colours.
            const ring: [number, number][] = [];
            for (let x = -3; x < 3; x++) ring.push([x, -3]);
            for (let y = -3; y < 3; y++) ring.push([3, y]);
            for (let x = 3; x > -3; x--) ring.push([x, 3]);
            for (let y = 3; y > -3; y--) ring.push([-3, y]);
            ring.forEach(([dx, dy], r) => {
              const color = r % P;
              set(cx + dx, cy + dy, Role.Ref, this.palette[color]);
              node.refs.push({ cell: (cy + dy) * W + cx + dx, color });
            });
            for (let dy = -2; dy <= 2; dy++) {
              for (let dx = -2; dx <= 2; dx++) {
                const d = Math.max(Math.abs(dx), Math.abs(dy));
                set(cx + dx, cy + dy, Role.Align, d === 1 ? white : black);
              }
            }
          }
        }
        this.nodes.push(node);
      }
    }

    // Tiles along the Hilbert curve.
    const order = gilbert2d(W, H);
    const nsym = ECC_PARITY[format.ecc];
    const n = TILE_DATA + nsym;
    const cellsPerTile = Math.ceil((n * 8) / format.bpc);
    this.tiles = [];
    let cur: number[] = [];
    for (let k = 0; k < order.length; k++) {
      const idx = order[k];
      if (role[idx] !== Role.Data) continue;
      cur.push(idx);
      if (cur.length === cellsPerTile) {
        this.tiles.push({ cells: Int32Array.from(cur), n, nsym });
        cur = [];
      }
    }
    // Leftover cells become filler with fixed pseudo-random colours.
    const rand = mulberry32(0xf111e5);
    for (const idx of cur) set(idx % W, (idx / W) | 0, Role.Filler, this.palette[rand() % P]);

    // Per-cell lattice quad + weights.
    this.cellQuad = new Int32Array(W * H);
    this.cellT = new Float32Array(W * H);
    this.cellU = new Float32Array(W * H);
    const ctx: number[] = [];
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (role[y * W + x] === Role.Data) continue;
        let touches = false;
        for (let dy = -1; dy <= 1 && !touches; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < W && yy < H && role[yy * W + xx] === Role.Data) {
              touches = true;
              break;
            }
          }
        if (touches) ctx.push(y * W + x);
      }
    this.contextCells = Int32Array.from(ctx);
    this.quadColStart = new Int32Array(nx).fill(W);
    for (let x = W - 1; x >= 0; x--) {
      let i = 0;
      while (i < nx - 2 && x + 0.5 > this.latX[i + 1]) i++;
      this.quadColStart[i] = x;
    }
    for (let y = 0; y < H; y++) {
      const cy = y + 0.5;
      let j = 0;
      while (j < ny - 2 && cy > this.latY[j + 1]) j++;
      const u = (cy - this.latY[j]) / (this.latY[j + 1] - this.latY[j]);
      for (let x = 0; x < W; x++) {
        const cx = x + 0.5;
        let i = 0;
        while (i < nx - 2 && cx > this.latX[i + 1]) i++;
        const t = (cx - this.latX[i]) / (this.latX[i + 1] - this.latX[i]);
        const idx = y * W + x;
        this.cellQuad[idx] = j * (nx - 1) + i;
        this.cellT[idx] = Math.min(1, Math.max(0, t));
        this.cellU[idx] = Math.min(1, Math.max(0, u));
      }
    }
  }

  get nx(): number {
    return this.latX.length;
  }

  get ny(): number {
    return this.latY.length;
  }

  /** Payload bytes per frame (fountain symbol bytes, excluding headers and parity). */
  get payloadPerFrame(): number {
    return this.tiles.length * SYMBOL_SIZE;
  }

  get rawBitsPerFrame(): number {
    return this.W * this.H * this.bpc;
  }
}

const cache = new Map<string, Layout>();

export function getLayout(format: FrameFormat): Layout {
  const key = formatKey(format);
  let l = cache.get(key);
  if (!l) {
    l = new Layout(format);
    cache.set(key, l);
  }
  return l;
}
