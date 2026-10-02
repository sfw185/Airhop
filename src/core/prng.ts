/** Small deterministic PRNG (mulberry32). Used for scrambling, not security. */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

export function keystream(seed: number, length: number): Uint8Array {
  const next = mulberry32(seed);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 4) {
    const v = next();
    out[i] = v & 255;
    if (i + 1 < length) out[i + 1] = (v >>> 8) & 255;
    if (i + 2 < length) out[i + 2] = (v >>> 16) & 255;
    if (i + 3 < length) out[i + 3] = v >>> 24;
  }
  return out;
}
