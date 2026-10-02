/// <reference lib="webworker" />
import { FrameDecoder, type FrameResult } from '../core/frameDecoder';

export type WorkerRequest =
  | { kind: 'bitmap'; id: number; bitmap: ImageBitmap }
  | { kind: 'pixels'; id: number; width: number; height: number; buffer: ArrayBuffer };

export interface WorkerResponse {
  id: number;
  result: Omit<FrameResult, 'tileOk'> & { tileOk?: Uint8Array };
  /** Returned pixel buffer (pixels mode) so the main thread can reuse it. */
  buffer?: ArrayBuffer;
}

const decoder = new FrameDecoder();
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  let width: number, height: number, data: Uint8ClampedArray;
  if (msg.kind === 'bitmap') {
    width = msg.bitmap.width;
    height = msg.bitmap.height;
    if (!canvas || canvas.width !== width || canvas.height !== height) {
      canvas = new OffscreenCanvas(width, height);
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
    ctx!.drawImage(msg.bitmap, 0, 0);
    msg.bitmap.close();
    data = ctx!.getImageData(0, 0, width, height).data;
  } else {
    width = msg.width;
    height = msg.height;
    data = new Uint8ClampedArray(msg.buffer);
  }
  let result: FrameResult;
  try {
    result = decoder.decode({ width, height, data });
  } catch (e) {
    console.error(e);
    result = { stage: 'no-finders', finders: [], tilesTotal: 0, tilesOk: 0, payloads: [], alignFound: 0, alignTotal: 0, meanCorrections: 0, ms: 0, timings: {} };
  }
  const reply: WorkerResponse = { id: msg.id, result };
  const transfer: Transferable[] = [];
  if (msg.kind === 'pixels') {
    reply.buffer = msg.buffer;
    transfer.push(msg.buffer);
  }
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(reply, transfer);
};
