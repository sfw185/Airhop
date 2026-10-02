// Reed-Solomon over GF(2^8), primitive polynomial 0x11d, first consecutive root alpha^0.
// Systematic: codeword = data || parity. Supports shortened codes (n <= 255) and
// errors-and-erasures decoding (2*errors + erasures <= nsym).
//
// Polynomials are plain number arrays with the highest-degree coefficient first,
// which matches codeword byte order.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error('gf division by zero');
  if (a === 0) return 0;
  return EXP[(LOG[a] + 255 - LOG[b]) % 255];
}

function gfPow2(power: number): number {
  return EXP[((power % 255) + 255) % 255];
}

function gfInverse(x: number): number {
  return EXP[255 - LOG[x]];
}

function polyScale(p: number[], x: number): number[] {
  return p.map((c) => gfMul(c, x));
}

function polyAdd(p: number[], q: number[]): number[] {
  const n = Math.max(p.length, q.length);
  const r = new Array<number>(n).fill(0);
  for (let i = 0; i < p.length; i++) r[i + n - p.length] = p[i];
  for (let i = 0; i < q.length; i++) r[i + n - q.length] ^= q[i];
  return r;
}

function polyMul(p: number[], q: number[]): number[] {
  const r = new Array<number>(p.length + q.length - 1).fill(0);
  for (let j = 0; j < q.length; j++) {
    const qj = q[j];
    if (qj === 0) continue;
    for (let i = 0; i < p.length; i++) r[i + j] ^= gfMul(p[i], qj);
  }
  return r;
}

function polyEval(p: ArrayLike<number>, x: number): number {
  let y = p[0];
  for (let i = 1; i < p.length; i++) y = gfMul(y, x) ^ p[i];
  return y;
}

const generatorCache = new Map<number, Uint8Array>();

function generator(nsym: number): Uint8Array {
  let g = generatorCache.get(nsym);
  if (!g) {
    let p = [1];
    for (let i = 0; i < nsym; i++) p = polyMul(p, [1, gfPow2(i)]);
    g = Uint8Array.from(p);
    generatorCache.set(nsym, g);
  }
  return g;
}

/** Returns data followed by nsym parity bytes. data.length + nsym must be <= 255. */
export function rsEncode(data: Uint8Array, nsym: number): Uint8Array {
  if (data.length + nsym > 255) throw new Error('RS codeword too long');
  const gen = generator(nsym);
  const out = new Uint8Array(data.length + nsym);
  out.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = out[i];
    if (coef === 0) continue;
    const lc = LOG[coef];
    for (let j = 1; j < gen.length; j++) {
      const g = gen[j];
      if (g !== 0) out[i + j] ^= EXP[LOG[g] + lc];
    }
  }
  out.set(data);
  return out;
}

/** Syndromes with a leading 0 pad (index 0), S_j at index j+1. */
function syndromes(msg: Uint8Array, nsym: number): number[] {
  const s = new Array<number>(nsym + 1).fill(0);
  for (let j = 0; j < nsym; j++) s[j + 1] = polyEval(msg, gfPow2(j));
  return s;
}

function forneySyndromes(synd: number[], erasePos: number[], n: number): number[] {
  const fsynd = synd.slice(1);
  for (const p of erasePos) {
    const x = gfPow2(n - 1 - p);
    for (let j = 0; j < fsynd.length - 1; j++) fsynd[j] = gfMul(fsynd[j], x) ^ fsynd[j + 1];
  }
  return fsynd;
}

function findErrorLocator(synd: number[], nsym: number, eraseCount: number): number[] | null {
  let errLoc = [1];
  let oldLoc = [1];
  const syndShift = synd.length > nsym ? synd.length - nsym : 0;
  for (let i = 0; i < nsym - eraseCount; i++) {
    const k = i + syndShift;
    let delta = synd[k];
    for (let j = 1; j < errLoc.length; j++) delta ^= gfMul(errLoc[errLoc.length - 1 - j], synd[k - j]);
    oldLoc = oldLoc.concat([0]);
    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = polyScale(oldLoc, delta);
        oldLoc = polyScale(errLoc, gfInverse(delta));
        errLoc = newLoc;
      }
      errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
    }
  }
  let lead = 0;
  while (lead < errLoc.length && errLoc[lead] === 0) lead++;
  errLoc = errLoc.slice(lead);
  const errs = errLoc.length - 1;
  if (errs * 2 + eraseCount > nsym) return null;
  return errLoc;
}

/** Chien search. errLocRev is the locator with lowest-degree coefficient first. */
function findErrors(errLocRev: number[], n: number): number[] | null {
  const errs = errLocRev.length - 1;
  const pos: number[] = [];
  for (let i = 0; i < n; i++) {
    if (polyEval(errLocRev, gfPow2(i)) === 0) pos.push(n - 1 - i);
  }
  return pos.length === errs ? pos : null;
}

function errataLocator(coefPos: number[]): number[] {
  let loc = [1];
  for (const c of coefPos) loc = polyMul(loc, polyAdd([1], [gfPow2(c), 0]));
  return loc;
}

function errorEvaluator(synd: number[], errLoc: number[], nsym: number): number[] {
  const prod = polyMul(synd, errLoc);
  // remainder of prod / x^(nsym+1): keep the lowest nsym+1 coefficients
  return prod.slice(Math.max(0, prod.length - (nsym + 1)));
}

function correctErrata(msg: Uint8Array, synd: number[], errPos: number[]): boolean {
  const n = msg.length;
  const coefPos = errPos.map((p) => n - 1 - p);
  const errLoc = errataLocator(coefPos);
  const errEval = errorEvaluator(synd.slice().reverse(), errLoc, errLoc.length - 1).reverse();
  const X = coefPos.map((c) => gfPow2(c));
  for (let i = 0; i < X.length; i++) {
    const xiInv = gfInverse(X[i]);
    let locPrime = 1;
    for (let j = 0; j < X.length; j++) {
      if (j !== i) locPrime = gfMul(locPrime, 1 ^ gfMul(xiInv, X[j]));
    }
    if (locPrime === 0) return false;
    const y = gfMul(X[i], polyEval(errEval.slice().reverse(), xiInv));
    msg[errPos[i]] ^= gfDiv(y, locPrime);
  }
  return true;
}

export interface RsDecodeResult {
  data: Uint8Array;
  corrected: number;
}

/**
 * Decodes in place-safe fashion (input is not modified). Returns null when the
 * codeword is uncorrectable. erasures are byte indices into the codeword.
 */
export function rsDecode(codeword: Uint8Array, nsym: number, erasures: number[] = []): RsDecodeResult | null {
  const n = codeword.length;
  const k = n - nsym;
  if (erasures.length > nsym) return null;
  const msg = codeword.slice();
  for (const e of erasures) msg[e] = 0;
  const synd = syndromes(msg, nsym);
  let clean = true;
  for (let i = 1; i < synd.length; i++) {
    if (synd[i] !== 0) {
      clean = false;
      break;
    }
  }
  if (clean) return { data: msg.subarray(0, k), corrected: 0 };

  const fsynd = forneySyndromes(synd, erasures, n);
  const errLoc = findErrorLocator(fsynd, nsym, erasures.length);
  if (!errLoc) return null;
  const errPos = findErrors(errLoc.slice().reverse(), n);
  if (!errPos) return null;
  const all = erasures.concat(errPos);
  if (!correctErrata(msg, synd, all)) return null;
  const check = syndromes(msg, nsym);
  for (let i = 1; i < check.length; i++) if (check[i] !== 0) return null;
  let corrected = 0;
  for (let i = 0; i < n; i++) if (msg[i] !== codeword[i]) corrected++;
  return { data: msg.subarray(0, k), corrected };
}
