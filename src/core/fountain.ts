// Thin wrapper around the raptorq (RFC 6330) WebAssembly build. Callers must await
// initFountain() (browser) or call initFountainSync() (Node) once before use.
import init, { Decoder, Encoder, initSync } from 'raptorq';
import { SYMBOL_SIZE } from './format';

let ready: Promise<void> | null = null;
let initialised = false;

export function initFountain(wasm?: string | URL | BufferSource): Promise<void> {
  if (initialised) return Promise.resolve();
  ready ??= init(wasm as never).then(() => {
    initialised = true;
  });
  return ready;
}

export function initFountainSync(bytes: BufferSource): void {
  if (initialised) return;
  initSync(bytes);
  initialised = true;
}

/** Packet = 4-byte payload id (source block number, 24-bit symbol id) + SYMBOL_SIZE bytes. */
export function encodePackets(data: Uint8Array, repairRatio: number): Uint8Array[] {
  const enc = Encoder.with_defaults(data, SYMBOL_SIZE);
  const k = Math.ceil(data.length / SYMBOL_SIZE);
  // `repair_packets_per_block`: spread the repair budget over the source blocks RaptorQ picks.
  const blocks = Math.max(1, Math.ceil(k / 56403));
  const repair = Math.max(16, Math.ceil((k * repairRatio) / blocks));
  const packets = enc.encode(repair);
  enc.free();
  return packets;
}

export class FountainDecoder {
  private dec: Decoder;
  private seen = new Set<number>();
  readonly transferLength: number;
  readonly sourceSymbols: number;
  result: Uint8Array | null = null;

  constructor(transferLength: number) {
    this.transferLength = transferLength;
    this.sourceSymbols = Math.ceil(transferLength / SYMBOL_SIZE);
    this.dec = Decoder.with_defaults(BigInt(transferLength), SYMBOL_SIZE);
  }

  get unique(): number {
    return this.seen.size;
  }

  /** Returns true if the packet was new. */
  add(packet: Uint8Array): boolean {
    if (this.result) return false;
    const id = (packet[0] << 24) | (packet[1] << 16) | (packet[2] << 8) | packet[3];
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    const out = this.dec.decode(packet);
    if (out) {
      this.result = out;
      this.dec.free();
    }
    return true;
  }
}
