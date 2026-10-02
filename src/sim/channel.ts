// Synthetic screen -> camera channel, used by tests, the simulator script and the E2E video
// generator. It models the things that break screen-camera links in practice: perspective,
// lens distortion, optical blur, colour crosstalk and white balance error, display/camera
// gamma, ambient glare, vignetting, sensor noise, rolling-shutter frame seams and motion blur.

import { fitHomography, invert3, type Mat3, type Pt } from '../core/homography';
import { mulberry32 } from '../core/prng';

export interface Image {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface CameraParams {
  width: number;
  height: number;
  /** Where the screen image's corners land in the camera image (TL, TR, BR, BL). */
  corners: Pt[];
  /** Radial distortion coefficient (positive = barrel). */
  k1: number;
  /** Gaussian blur sigma in camera pixels. */
  blur: number;
  /** 3x3 colour mixing matrix applied in linear light (row-major). */
  color: number[];
  /** Exposure gain in linear light. */
  gain: number;
  /** Additive ambient light in linear units. */
  ambient: number;
  /** Optional glare spot: centre (camera px), radius (px), strength (linear). */
  glare?: { x: number; y: number; r: number; s: number };
  /** Vignetting strength (0 = none). */
  vignette: number;
  /** Gaussian noise sigma in 8-bit units. */
  noise: number;
  /** Rolling shutter seam: rows >= seam come from the next screen image. Fraction 0..1. */
  seam?: number;
  /** Seam blend width in rows. */
  seamWidth?: number;
  /** Seam direction: 'rows' (horizontal seam) or 'cols'. */
  seamAxis?: 'rows' | 'cols';
  /** Motion blur: displacement in camera px over the exposure. */
  motion?: { x: number; y: number };
  background: [number, number, number];
  seed: number;
}

const toLin = new Float32Array(256);
for (let i = 0; i < 256; i++) toLin[i] = Math.pow(i / 255, 2.2);

function sampleScreen(img: Image, x: number, y: number, out: Float32Array, o: number, wgt: number, bg: [number, number, number]): void {
  if (x < 0 || y < 0 || x >= img.width - 1 || y >= img.height - 1) {
    out[o] += bg[0] * wgt;
    out[o + 1] += bg[1] * wgt;
    out[o + 2] += bg[2] * wgt;
    return;
  }
  const x0 = x | 0, y0 = y | 0;
  const fx = x - x0, fy = y - y0;
  const p = (y0 * img.width + x0) * 4;
  const q = p + img.width * 4;
  const d = img.data;
  const w00 = (1 - fx) * (1 - fy) * wgt, w10 = fx * (1 - fy) * wgt, w01 = (1 - fx) * fy * wgt, w11 = fx * fy * wgt;
  out[o] += toLin[d[p]] * w00 + toLin[d[p + 4]] * w10 + toLin[d[q]] * w01 + toLin[d[q + 4]] * w11;
  out[o + 1] += toLin[d[p + 1]] * w00 + toLin[d[p + 5]] * w10 + toLin[d[q + 1]] * w01 + toLin[d[q + 5]] * w11;
  out[o + 2] += toLin[d[p + 2]] * w00 + toLin[d[p + 6]] * w10 + toLin[d[q + 2]] * w01 + toLin[d[q + 6]] * w11;
}

function gaussianBlur(buf: Float32Array, w: number, h: number, sigma: number): void {
  if (sigma < 0.3) return;
  const r = Math.ceil(sigma * 2.5);
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) s += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const tmp = new Float32Array(buf.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        let a = 0;
        for (let i = -r; i <= r; i++) {
          const xx = Math.min(w - 1, Math.max(0, x + i));
          a += buf[(y * w + xx) * 3 + c] * k[i + r];
        }
        tmp[(y * w + x) * 3 + c] = a;
      }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        let a = 0;
        for (let i = -r; i <= r; i++) {
          const yy = Math.min(h - 1, Math.max(0, y + i));
          a += tmp[(yy * w + x) * 3 + c] * k[i + r];
        }
        buf[(y * w + x) * 3 + c] = a;
      }
}

/** Renders what the camera sees. `next` is the following screen image for rolling-shutter seams. */
export function capture(screen: Image, cam: CameraParams, next?: Image): Image {
  const { width: cw, height: ch } = cam;
  const src: Pt[] = [
    { x: 0, y: 0 },
    { x: screen.width, y: 0 },
    { x: screen.width, y: screen.height },
    { x: 0, y: screen.height },
  ];
  const Hs = fitHomography(src, cam.corners);
  if (!Hs) throw new Error('bad camera corners');
  const Hinv = invert3(Hs) as Mat3;
  const lin = new Float32Array(cw * ch * 3);
  const cx = cw / 2, cy = ch / 2;
  const norm = 1 / (Math.max(cw, ch) / 2);
  const bgLin: [number, number, number] = [toLin[cam.background[0]], toLin[cam.background[1]], toLin[cam.background[2]]];
  const motionSteps = cam.motion ? 4 : 1;
  const ss = 2; // supersampling per axis
  const wgt = 1 / (ss * ss * motionSteps);
  const seamAxis = cam.seamAxis ?? 'rows';
  const seamPos = cam.seam !== undefined ? cam.seam * (seamAxis === 'rows' ? ch : cw) : Infinity;
  const seamW = cam.seamWidth ?? 6;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const o = (y * cw + x) * 3;
      const along = seamAxis === 'rows' ? y : x;
      let mixNext = 0;
      if (next && along >= seamPos - seamW / 2) mixNext = Math.min(1, (along - (seamPos - seamW / 2)) / Math.max(1, seamW));
      for (let m = 0; m < motionSteps; m++) {
        const mt = motionSteps > 1 ? m / (motionSteps - 1) - 0.5 : 0;
        for (let sy = 0; sy < ss; sy++) {
          for (let sx = 0; sx < ss; sx++) {
            let px = x + (sx + 0.5) / ss + (cam.motion ? cam.motion.x * mt : 0);
            let py = y + (sy + 0.5) / ss + (cam.motion ? cam.motion.y * mt : 0);
            // Lens distortion: camera pixel -> ideal (undistorted) pixel.
            const dx = (px - cx) * norm, dy = (py - cy) * norm;
            const r2 = dx * dx + dy * dy;
            const f = 1 + cam.k1 * r2;
            px = cx + dx * f / norm;
            py = cy + dy * f / norm;
            const wq = Hinv[6] * px + Hinv[7] * py + Hinv[8];
            const sxp = (Hinv[0] * px + Hinv[1] * py + Hinv[2]) / wq;
            const syp = (Hinv[3] * px + Hinv[4] * py + Hinv[5]) / wq;
            if (mixNext <= 0 || !next) sampleScreen(screen, sxp, syp, lin, o, wgt, bgLin);
            else if (mixNext >= 1) sampleScreen(next, sxp, syp, lin, o, wgt, bgLin);
            else {
              sampleScreen(screen, sxp, syp, lin, o, wgt * (1 - mixNext), bgLin);
              sampleScreen(next, sxp, syp, lin, o, wgt * mixNext, bgLin);
            }
          }
        }
      }
    }
  }
  gaussianBlur(lin, cw, ch, cam.blur);
  const rand = mulberry32(cam.seed);
  const gauss = () => {
    const u = (rand() + 1) / 4294967297, v = rand() / 4294967296;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const out = new Uint8ClampedArray(cw * ch * 4);
  const M = cam.color;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const o = (y * cw + x) * 3;
      const r = lin[o], g = lin[o + 1], b = lin[o + 2];
      const dx = (x - cx) * norm, dy = (y - cy) * norm;
      const v = cam.gain * (1 - cam.vignette * (dx * dx + dy * dy));
      let amb = cam.ambient;
      if (cam.glare) {
        const gd = ((x - cam.glare.x) ** 2 + (y - cam.glare.y) ** 2) / (cam.glare.r * cam.glare.r);
        amb += cam.glare.s * Math.exp(-gd);
      }
      const p = (y * cw + x) * 4;
      const ch3 = [M[0] * r + M[1] * g + M[2] * b, M[3] * r + M[4] * g + M[5] * b, M[6] * r + M[7] * g + M[8] * b];
      for (let c = 0; c < 3; c++) {
        const val = Math.max(0, ch3[c] * v + amb);
        out[p + c] = Math.pow(Math.min(1, val), 1 / 2.2) * 255 + gauss() * cam.noise;
      }
      out[p + 3] = 255;
    }
  }
  return { width: cw, height: ch, data: out };
}

export type Severity = 'clean' | 'mild' | 'moderate' | 'harsh';

/** Random but plausible camera parameters. `fill` is the fraction of the frame the code spans. */
export function randomCamera(seed: number, screenW: number, screenH: number, opts: { width: number; height: number; fill: number; severity: Severity }): CameraParams {
  const rand = mulberry32(seed);
  const u = () => rand() / 4294967296;
  const sev = { clean: 0, mild: 0.4, moderate: 0.7, harsh: 1 }[opts.severity];
  const { width, height, fill } = opts;
  const aspect = screenW / screenH;
  let bw = width * fill, bh = bw / aspect;
  if (bh > height * fill) {
    bh = height * fill;
    bw = bh * aspect;
  }
  const cx = width / 2 + (u() - 0.5) * (width - bw) * 0.5 * sev;
  const cy = height / 2 + (u() - 0.5) * (height - bh) * 0.5 * sev;
  const rot = (u() - 0.5) * 0.35 * sev;
  const persp = 0.12 * sev;
  const base: Pt[] = [
    { x: -bw / 2, y: -bh / 2 },
    { x: bw / 2, y: -bh / 2 },
    { x: bw / 2, y: bh / 2 },
    { x: -bw / 2, y: bh / 2 },
  ];
  // Perspective: shrink one side.
  const side = Math.floor(u() * 4);
  const shrink = 1 - persp * u();
  const corners = base.map((p, i) => {
    let { x, y } = p;
    if ((side === 0 && (i === 0 || i === 1)) || (side === 2 && (i === 2 || i === 3))) x *= shrink;
    if ((side === 1 && (i === 1 || i === 2)) || (side === 3 && (i === 0 || i === 3))) y *= shrink;
    x += (u() - 0.5) * bw * 0.03 * sev;
    y += (u() - 0.5) * bh * 0.03 * sev;
    return { x: cx + x * Math.cos(rot) - y * Math.sin(rot), y: cy + x * Math.sin(rot) + y * Math.cos(rot) };
  });
  const cross = 0.06 + 0.12 * sev * u();
  const wb = () => 1 + (u() - 0.5) * 0.3 * sev;
  const mk = (main: number, a: number, b: number) => [main, a, b];
  const r = mk(1 - cross, cross * 0.7, cross * 0.3);
  const g = mk(cross * 0.5, 1 - cross, cross * 0.5);
  const bl = mk(cross * 0.2, cross * 0.8, 1 - cross);
  const wr = wb(), wg = wb(), wbb = wb();
  const color = [r[0] * wr, r[1] * wr, r[2] * wr, g[0] * wg, g[1] * wg, g[2] * wg, bl[0] * wbb, bl[1] * wbb, bl[2] * wbb];
  return {
    width,
    height,
    corners,
    k1: (u() - 0.3) * 0.08 * sev,
    blur: 0.6 + 1.2 * sev * u(),
    color,
    gain: 0.75 + 0.3 * u(),
    ambient: 0.01 + 0.06 * sev * u(),
    glare: sev > 0.5 && u() < 0.5 ? { x: cx + (u() - 0.5) * bw, y: cy + (u() - 0.5) * bh, r: bw * (0.05 + 0.1 * u()), s: 0.3 * u() } : undefined,
    vignette: 0.25 * sev * u(),
    noise: 1 + 5 * sev * u(),
    background: [40, 40, 45],
    seed: seed ^ 0x9e3779b9,
  };
}
