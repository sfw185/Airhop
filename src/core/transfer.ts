import { crc32 } from './crc';
import { encodePackets, FountainDecoder } from './fountain';
import { SYMBOL_SIZE } from './format';
import { packTile, type TilePayload } from './tile';

/*
 * Transfer object (what the fountain code carries):
 *   "AHOP" | version u8 | flags u8 | crc32(original) u32 | originalSize u32 |
 *   nameLen u16 | name utf8 | mimeLen u8 | mime utf8 | payload
 * flags bit 0: payload is deflate-raw compressed.
 */

const MAGIC = [0x41, 0x48, 0x4f, 0x50];
const FLAG_DEFLATE = 1;

export interface FileInfo {
  name: string;
  mime: string;
  data: Uint8Array;
}

async function streamBytes(input: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const body = new Blob([input as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

export async function packFile(file: FileInfo, compress = true): Promise<Uint8Array> {
  let payload = file.data;
  let flags = 0;
  if (compress && typeof CompressionStream !== 'undefined' && file.data.length > 64) {
    const z = await streamBytes(file.data, new CompressionStream('deflate-raw'));
    if (z.length < file.data.length * 0.97) {
      payload = z;
      flags |= FLAG_DEFLATE;
    }
  }
  const enc = new TextEncoder();
  const name = enc.encode(file.name).slice(0, 1024);
  const mime = enc.encode(file.mime || 'application/octet-stream').slice(0, 255);
  const head = new Uint8Array(4 + 1 + 1 + 4 + 4 + 2 + name.length + 1 + mime.length);
  const dv = new DataView(head.buffer);
  head.set(MAGIC, 0);
  head[4] = 1;
  head[5] = flags;
  dv.setUint32(6, crc32(file.data));
  dv.setUint32(10, file.data.length);
  dv.setUint16(14, name.length);
  head.set(name, 16);
  head[16 + name.length] = mime.length;
  head.set(mime, 17 + name.length);
  const out = new Uint8Array(head.length + payload.length);
  out.set(head);
  out.set(payload, head.length);
  return out;
}

export interface TransferHeader {
  name: string;
  mime: string;
  size: number;
  compressed: boolean;
}

/** Parses the header only (available as soon as the first source symbol arrives). */
export function parseHeader(bytes: Uint8Array): (TransferHeader & { headerLength: number; crc: number }) | null {
  if (bytes.length < 17 || MAGIC.some((m, i) => bytes[i] !== m)) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = bytes[5];
  const crc = dv.getUint32(6);
  const size = dv.getUint32(10);
  const nameLen = dv.getUint16(14);
  if (bytes.length < 17 + nameLen) return null;
  const dec = new TextDecoder();
  const name = dec.decode(bytes.subarray(16, 16 + nameLen));
  const mimeLen = bytes[16 + nameLen];
  const mime = dec.decode(bytes.subarray(17 + nameLen, 17 + nameLen + mimeLen));
  return { name, mime, size, compressed: !!(flags & FLAG_DEFLATE), headerLength: 17 + nameLen + mimeLen, crc };
}

export async function unpackFile(bytes: Uint8Array): Promise<FileInfo & { crcOk: boolean }> {
  const h = parseHeader(bytes);
  if (!h) throw new Error('not an Airhop transfer');
  let data = bytes.subarray(h.headerLength);
  if (h.compressed) data = await streamBytes(data, new DecompressionStream('deflate-raw'));
  return { name: h.name, mime: h.mime, data, crcOk: crc32(data) === h.crc && data.length === h.size };
}

/** Produces tile payloads for the sender, cycling through a shuffled packet pool. */
export class SendSession {
  readonly session: number;
  readonly transferLength: number;
  readonly sourceSymbols: number;
  private packets: Uint8Array[];
  private order: Uint32Array;
  private cursor = 0;

  constructor(transfer: Uint8Array, opts: { repairRatio?: number; session?: number } = {}) {
    this.transferLength = transfer.length;
    this.session = opts.session ?? (Math.random() * 0x10000) | 0;
    this.packets = encodePackets(transfer, opts.repairRatio ?? (transfer.length < 8 << 20 ? 1 : 0.5));
    this.sourceSymbols = Math.ceil(transfer.length / SYMBOL_SIZE);
    // Source packets first (cheapest to decode, and the header lives in symbol 0), then a
    // deterministic shuffle of the repair packets.
    const n = this.packets.length;
    this.order = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.order[i] = i;
    let s = this.session * 2654435761 >>> 0;
    for (let i = n - 1; i > this.sourceSymbols; i--) {
      s = (s * 1664525 + 1013904223) >>> 0;
      const j = this.sourceSymbols + (s % (i - this.sourceSymbols + 1));
      const t = this.order[i];
      this.order[i] = this.order[j];
      this.order[j] = t;
    }
  }

  get poolSize(): number {
    return this.packets.length;
  }

  /** Total packets emitted so far (for UI). */
  get emitted(): number {
    return this.cursor;
  }

  next(count: number): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      const p = this.packets[this.order[this.cursor % this.packets.length]];
      this.cursor++;
      out.push(packTile({ session: this.session, transferLength: this.transferLength, packet: p }));
    }
    return out;
  }
}

export interface ReceiveProgress {
  session: number;
  transferLength: number;
  unique: number;
  needed: number;
  header: TransferHeader | null;
  done: boolean;
}

/** Collects tile payloads from any number of frames and reassembles the transfer. */
export class ReceiveSession {
  private decoders = new Map<string, FountainDecoder>();
  private headers = new Map<string, TransferHeader>();
  active: string | null = null;
  completed: { key: string; bytes: Uint8Array } | null = null;

  /** Returns the number of new packets accepted. */
  add(payloads: TilePayload[]): number {
    let fresh = 0;
    for (const p of payloads) {
      if (p.transferLength === 0) continue;
      const key = `${p.session}:${p.transferLength}`;
      let d = this.decoders.get(key);
      if (!d) {
        d = new FountainDecoder(p.transferLength);
        this.decoders.set(key, d);
      }
      this.active = key;
      // Symbol 0 of block 0 carries the transfer header.
      if (!this.headers.has(key) && p.packet[0] === 0 && p.packet[1] === 0 && p.packet[2] === 0 && p.packet[3] === 0) {
        const h = parseHeader(p.packet.subarray(4));
        if (h) this.headers.set(key, h);
      }
      if (d.add(p.packet)) fresh++;
      if (d.result && !this.completed) {
        this.completed = { key, bytes: d.result };
        const h = parseHeader(d.result);
        if (h) this.headers.set(key, h);
      }
    }
    return fresh;
  }

  progress(): ReceiveProgress | null {
    if (!this.active) return null;
    const d = this.decoders.get(this.active)!;
    const [session] = this.active.split(':').map(Number);
    return {
      session,
      transferLength: d.transferLength,
      unique: d.unique,
      needed: d.sourceSymbols,
      header: this.headers.get(this.active) ?? null,
      done: !!d.result,
    };
  }

  reset(): void {
    this.decoders.clear();
    this.headers.clear();
    this.active = null;
    this.completed = null;
  }
}
