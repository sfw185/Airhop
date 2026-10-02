import { encodeFrameRGB } from '../core/frameEncoder';
import type { Layout } from '../core/layout';

export const QUIET = 4;

/**
 * Draws frames for one layout onto a canvas. The frame is built at one pixel per cell and
 * scaled up by an integer factor with smoothing disabled, so cell edges stay crisp.
 */
export class FrameRenderer {
  readonly layout: Layout;
  private small: HTMLCanvasElement;
  private sctx: CanvasRenderingContext2D;
  private img: ImageData;
  private frameNo = 0;

  constructor(layout: Layout) {
    this.layout = layout;
    const w = layout.W + QUIET * 2;
    const h = layout.H + QUIET * 2;
    this.small = document.createElement('canvas');
    this.small.width = w;
    this.small.height = h;
    this.sctx = this.small.getContext('2d')!;
    this.img = this.sctx.createImageData(w, h);
    this.img.data.fill(255);
  }

  /** Cell size in device pixels that fits the canvas. */
  scaleFor(canvas: HTMLCanvasElement): number {
    const w = this.layout.W + QUIET * 2;
    const h = this.layout.H + QUIET * 2;
    return Math.floor(Math.min(canvas.width / w, canvas.height / h));
  }

  draw(canvas: HTMLCanvasElement, tiles: Uint8Array[]): void {
    const { layout } = this;
    const rgb = encodeFrameRGB(layout, tiles, this.frameNo++);
    const d = this.img.data;
    const stride = layout.W + QUIET * 2;
    for (let y = 0; y < layout.H; y++) {
      let p = ((y + QUIET) * stride + QUIET) * 4;
      let o = y * layout.W * 3;
      for (let x = 0; x < layout.W; x++, p += 4, o += 3) {
        d[p] = rgb[o];
        d[p + 1] = rgb[o + 1];
        d[p + 2] = rgb[o + 2];
      }
    }
    this.sctx.putImageData(this.img, 0, 0);
    const ctx = canvas.getContext('2d')!;
    const s = Math.max(1, this.scaleFor(canvas));
    const w = this.small.width * s;
    const h = this.small.height * s;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(this.small, Math.floor((canvas.width - w) / 2), Math.floor((canvas.height - h) / 2), w, h);
  }
}
