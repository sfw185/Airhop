import { crc16 } from './crc';
import { SYMBOL_SIZE, TILE_DATA } from './format';

/** A RaptorQ packet as produced by the raptorq crate: 4-byte payload id + symbol. */
export const PACKET_SIZE = 4 + SYMBOL_SIZE;

export interface TilePayload {
  session: number;
  transferLength: number;
  /** Serialized RaptorQ packet (payload id + symbol). */
  packet: Uint8Array;
}

/** Layout: session u16 | transfer length u32 | packet (4 + SYMBOL_SIZE) | crc16. */
export function packTile(p: TilePayload): Uint8Array {
  if (p.packet.length !== PACKET_SIZE) throw new Error(`packet must be ${PACKET_SIZE} bytes`);
  const out = new Uint8Array(TILE_DATA);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, p.session);
  dv.setUint32(2, p.transferLength);
  out.set(p.packet, 6);
  dv.setUint16(TILE_DATA - 2, crc16(out, 0xffff, 0, TILE_DATA - 2));
  return out;
}

export function unpackTile(data: Uint8Array): TilePayload | null {
  if (data.length < TILE_DATA) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (crc16(data, 0xffff, 0, TILE_DATA - 2) !== dv.getUint16(TILE_DATA - 2)) return null;
  return {
    session: dv.getUint16(0),
    transferLength: dv.getUint32(2),
    packet: data.slice(6, 6 + PACKET_SIZE),
  };
}
