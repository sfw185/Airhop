const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, seed = 0): number {
  let c = ~seed >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC32_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** CRC-16/CCITT-FALSE (poly 0x1021). */
export function crc16(data: ArrayLike<number>, init = 0xffff, start = 0, end = data.length): number {
  let crc = init;
  for (let i = start; i < end; i++) {
    crc ^= data[i] << 8;
    for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}
