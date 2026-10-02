import { deflateSync, inflateSync } from 'node:zlib';
import { crc32 } from '../core/crc';

/** Minimal RGBA PNG encoder for debugging and fixtures (Node only). */
export function encodePNG(width: number, height: number, rgba: ArrayLike<number>): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let i = 0; i < width * 4; i++) raw[y * (width * 4 + 1) + 1 + i] = rgba[y * width * 4 + i];
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Decodes 8-bit RGB/RGBA non-interlaced PNGs (all filter types). Node only. */
export function decodePNG(buf: Uint8Array): { width: number; height: number; data: Uint8ClampedArray } {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 8;
  let width = 0, height = 0, colorType = 0;
  const idat: Buffer[] = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o);
    const type = b.toString('ascii', o + 4, o + 8);
    const d = b.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      width = d.readUInt32BE(0);
      height = d.readUInt32BE(4);
      if (d[8] !== 8 || d[12] !== 0) throw new Error('unsupported PNG');
      colorType = d[9];
    } else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!bpp) throw new Error('unsupported PNG colour type');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const cur = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const up = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      cur[i] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      out[(y * width + x) * 4] = cur[x * bpp];
      out[(y * width + x) * 4 + 1] = cur[x * bpp + 1];
      out[(y * width + x) * 4 + 2] = cur[x * bpp + 2];
      out[(y * width + x) * 4 + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
    }
    prev.set(cur);
  }
  return { width, height, data: out };
}
