import { describe, expect, it } from 'vitest';
import { rsDecode, rsEncode } from '../src/core/rs';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function corrupt(cw: Uint8Array, count: number, rand: () => number, avoid = new Set<number>()): number[] {
  const pos = new Set<number>();
  while (pos.size < count) {
    const p = Math.floor(rand() * cw.length);
    if (!avoid.has(p)) pos.add(p);
  }
  for (const p of pos) cw[p] ^= 1 + Math.floor(rand() * 255);
  return [...pos];
}

describe('reed-solomon', () => {
  it('round-trips clean codewords', () => {
    const data = Uint8Array.from({ length: 200 }, (_, i) => (i * 37) & 255);
    const cw = rsEncode(data, 40);
    expect(cw.length).toBe(240);
    const res = rsDecode(cw, 40);
    expect(res).not.toBeNull();
    expect(Array.from(res!.data)).toEqual(Array.from(data));
  });

  it('corrects up to nsym/2 random errors', () => {
    const rand = rng(1);
    for (let trial = 0; trial < 300; trial++) {
      const k = 20 + Math.floor(rand() * 200);
      const nsym = 2 + 2 * Math.floor(rand() * Math.min(20, (255 - k) / 2));
      const data = Uint8Array.from({ length: k }, () => Math.floor(rand() * 256));
      const cw = rsEncode(data, nsym);
      const nerr = Math.floor(rand() * (nsym / 2 + 1));
      corrupt(cw, nerr, rand);
      const res = rsDecode(cw, nsym);
      expect(res, `trial ${trial} k=${k} nsym=${nsym} nerr=${nerr}`).not.toBeNull();
      expect(Array.from(res!.data)).toEqual(Array.from(data));
      expect(res!.corrected).toBe(nerr);
    }
  });

  it('corrects errors plus erasures within 2e+s <= nsym', () => {
    const rand = rng(2);
    for (let trial = 0; trial < 300; trial++) {
      const k = 50 + Math.floor(rand() * 150);
      const nsym = 32;
      const data = Uint8Array.from({ length: k }, () => Math.floor(rand() * 256));
      const cw = rsEncode(data, nsym);
      const s = Math.floor(rand() * nsym);
      const e = Math.floor((nsym - s) / 2);
      const erased = corrupt(cw, s, rand);
      corrupt(cw, e, rand, new Set(erased));
      const res = rsDecode(cw, nsym, erased);
      expect(res, `trial ${trial} s=${s} e=${e}`).not.toBeNull();
      expect(Array.from(res!.data)).toEqual(Array.from(data));
    }
  });

  it('reports failure (not garbage) beyond capacity in the vast majority of cases', () => {
    const rand = rng(3);
    let wrong = 0;
    for (let trial = 0; trial < 300; trial++) {
      const data = Uint8Array.from({ length: 180 }, () => Math.floor(rand() * 256));
      const cw = rsEncode(data, 32);
      corrupt(cw, 17 + Math.floor(rand() * 30), rand);
      const res = rsDecode(cw, 32);
      if (res && Array.from(res.data).join() !== Array.from(data).join()) wrong++;
    }
    expect(wrong).toBeLessThan(3);
  });
});
