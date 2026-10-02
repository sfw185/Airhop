import { crc16 } from './crc';

/** Bits per cell. 1 = black/white, 2 = 4 colours, 3 = 8 colours. */
export type BitsPerCell = 1 | 2 | 3;
/** Reed-Solomon strength per tile. */
export type EccLevel = 0 | 1 | 2 | 3;

export interface FrameFormat {
  /** Grid width in cells, multiple of 8, 40..512. */
  width: number;
  /** Grid height in cells, multiple of 8, 40..512. */
  height: number;
  bpc: BitsPerCell;
  ecc: EccLevel;
}

export const PROTOCOL_VERSION = 1;

/** RaptorQ symbol size carried by every tile. Fixed so density can change mid-transfer. */
export const SYMBOL_SIZE = 176;
/** session(2) + transferLength(4) + raptorq payload id(4) ... symbol ... crc16(2) */
export const TILE_HEADER = 10;
export const TILE_TRAILER = 2;
export const TILE_DATA = TILE_HEADER + SYMBOL_SIZE + TILE_TRAILER;
/** Parity bytes per tile codeword for each ECC level. */
export const ECC_PARITY: readonly number[] = [24, 40, 56, 67];
export const ECC_NAMES = ['L', 'M', 'Q', 'H'] as const;

export const MIN_DIM = 40;
export const MAX_DIM = 512;

export type RGB = readonly [number, number, number];

export const BLACK: RGB = [0, 0, 0];
export const WHITE: RGB = [255, 255, 255];

/**
 * Palettes. The 4-colour palette is the odd-parity tetrahedron of the RGB cube, so any
 * two symbols differ in two channels. The 8-colour palette uses one bit per channel.
 */
export const PALETTES: Record<BitsPerCell, readonly RGB[]> = {
  1: [BLACK, WHITE],
  2: [WHITE, [255, 0, 0], [0, 255, 0], [0, 0, 255]],
  3: [
    [0, 0, 0],
    [0, 0, 255],
    [0, 255, 0],
    [0, 255, 255],
    [255, 0, 0],
    [255, 0, 255],
    [255, 255, 0],
    [255, 255, 255],
  ],
};

const FORMAT_CRC_INIT = 0xa1b0 ^ PROTOCOL_VERSION;

export function validateFormat(f: FrameFormat): void {
  for (const d of [f.width, f.height]) {
    if (d % 8 !== 0 || d < MIN_DIM || d > MAX_DIM) throw new Error(`invalid grid dimension ${d}`);
  }
  if (![1, 2, 3].includes(f.bpc)) throw new Error('invalid bpc');
  if (![0, 1, 2, 3].includes(f.ecc)) throw new Error('invalid ecc');
}

/**
 * 16 data bits: width/8-1 (6) | height/8-1 (6) | bpc-1 (2) | ecc (2), then CRC-16.
 * The CRC is salted with the corner index: the four copies are placed rotation-symmetrically,
 * so without the salt a rotated read would pass the check.
 */
export function encodeFormatBits(f: FrameFormat, corner: number): Uint8Array {
  validateFormat(f);
  const word = (((f.width / 8 - 1) & 63) << 10) | (((f.height / 8 - 1) & 63) << 4) | ((f.bpc - 1) << 2) | f.ecc;
  const crc = crc16([word >> 8, word & 255], FORMAT_CRC_INIT ^ (corner * 0x1357));
  const bits = new Uint8Array(32);
  for (let i = 0; i < 16; i++) bits[i] = (word >> (15 - i)) & 1;
  for (let i = 0; i < 16; i++) bits[16 + i] = (crc >> (15 - i)) & 1;
  return bits;
}

export function decodeFormatBits(bits: ArrayLike<number>, corner: number): FrameFormat | null {
  let word = 0;
  let crc = 0;
  for (let i = 0; i < 16; i++) word = (word << 1) | (bits[i] & 1);
  for (let i = 0; i < 16; i++) crc = (crc << 1) | (bits[16 + i] & 1);
  if (crc16([word >> 8, word & 255], FORMAT_CRC_INIT ^ (corner * 0x1357)) !== crc) return null;
  const width = (((word >> 10) & 63) + 1) * 8;
  const height = (((word >> 4) & 63) + 1) * 8;
  const bpc = (((word >> 2) & 3) + 1) as BitsPerCell;
  const ecc = (word & 3) as EccLevel;
  if (bpc > 3 || width < MIN_DIM || height < MIN_DIM) return null;
  return { width, height, bpc, ecc };
}

export function formatKey(f: FrameFormat): string {
  return `${f.width}x${f.height}/${f.bpc}/${f.ecc}`;
}
