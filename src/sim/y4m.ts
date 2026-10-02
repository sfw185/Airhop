import { openSync, writeSync, closeSync } from 'node:fs';

/** Streams RGBA frames into a YUV4MPEG2 (4:2:0, BT.601 limited range) file for Chromium's fake camera. */
export class Y4MWriter {
  private fd: number;
  constructor(path: string, readonly width: number, readonly height: number, fps: number) {
    this.fd = openSync(path, 'w');
    writeSync(this.fd, `YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420jpeg\n`);
  }

  write(rgba: ArrayLike<number>): void {
    const { width: w, height: h } = this;
    const Y = Buffer.alloc(w * h);
    const U = Buffer.alloc((w / 2) * (h / 2));
    const V = Buffer.alloc((w / 2) * (h / 2));
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        Y[y * w + x] = Math.round(16 + 0.257 * rgba[p] + 0.504 * rgba[p + 1] + 0.098 * rgba[p + 2]);
      }
    for (let y = 0; y < h / 2; y++)
      for (let x = 0; x < w / 2; x++) {
        let r = 0, g = 0, b = 0;
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const p = ((2 * y + dy) * w + 2 * x + dx) * 4;
          r += rgba[p];
          g += rgba[p + 1];
          b += rgba[p + 2];
        }
        r /= 4;
        g /= 4;
        b /= 4;
        U[y * (w / 2) + x] = Math.round(128 - 0.148 * r - 0.291 * g + 0.439 * b);
        V[y * (w / 2) + x] = Math.round(128 + 0.439 * r - 0.368 * g - 0.071 * b);
      }
    writeSync(this.fd, 'FRAME\n');
    writeSync(this.fd, Y);
    writeSync(this.fd, U);
    writeSync(this.fd, V);
  }

  close(): void {
    closeSync(this.fd);
  }
}
