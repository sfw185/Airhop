import { SYMBOL_SIZE } from '../core/format';
import { initFountain } from '../core/fountain';
import type { FrameResult } from '../core/frameDecoder';
import { ReceiveSession, unpackFile } from '../core/transfer';
import type { WorkerRequest, WorkerResponse } from './decode.worker';
import DecodeWorker from './decode.worker?worker';
import { formatBytes, formatDuration, formatRate, h } from './dom';
import wasmUrl from 'raptorq/raptorq_bg.wasm?url';

const BPC_NAMES = ['', '2 colours', '4 colours', '8 colours'];

export function mountReceive(root: HTMLElement): () => void {
  const video = h('video', { playsinline: true, muted: true, autoplay: true }) as HTMLVideoElement;
  const overlay = h('canvas', { class: 'overlay' }) as HTMLCanvasElement;
  const viewport = h('div', { class: 'viewport' }, video, overlay);
  const status = h('div', { class: 'status' }, 'Camera off');
  const bar = h('div', { class: 'progress' }, h('div', { class: 'fill' }));
  const fill = bar.firstElementChild as HTMLElement;
  const stats = h('div', { class: 'stats' });
  const fileLine = h('div', { class: 'fileline' });
  const startBtn = h('button', { type: 'button' }, 'Start camera');
  const camSelect = h('select', { 'aria-label': 'Camera', hidden: true }) as HTMLSelectElement;
  const zoom = h('input', { type: 'range', 'aria-label': 'Zoom', hidden: true }) as HTMLInputElement;
  const videoFile = h('input', { type: 'file', accept: 'video/*', class: 'visually-hidden', id: 'vfile' }) as HTMLInputElement;
  const videoLink = h('label', { for: 'vfile', class: 'link' }, 'Decode a recorded video');
  const resetBtn = h('button', { type: 'button', class: 'secondary', hidden: true }, 'Start over');
  const result = h('div', { class: 'result', hidden: true });
  const err = h('p', { class: 'error', role: 'alert' });
  const panel = h(
    'div',
    { class: 'sheet' },
    fileLine,
    bar,
    status,
    stats,
    h('div', { class: 'row' }, startBtn, camSelect, zoom, resetBtn),
    h('div', { class: 'row small' }, videoFile, videoLink),
    err,
    result,
  );
  const view = h(
    'div',
    { class: 'receiver' },
    h('nav', {}, h('a', { href: '#' }, '← Airhop'), h('span', { class: 'title' }, 'Receive')),
    viewport,
    panel,
  );
  root.append(view);

  const recv = new ReceiveSession();
  const workerCount = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
  const workers: { w: Worker; busy: boolean }[] = [];
  const useBitmap = typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined';
  const grab = h('canvas') as HTMLCanvasElement;
  const grabCtx = grab.getContext('2d', { willReadFrequently: true })!;
  let stream: MediaStream | null = null;
  let running = false;
  let nextId = 0;
  let lastResult: FrameResult | null = null;
  let lastResultSize = { w: 0, h: 0 };
  let firstPacketAt = 0;
  let frames = 0, located = 0, tilesOk = 0, tilesTotal = 0;
  let windowStart = performance.now(), windowFrames = 0, procFps = 0;
  let done = false;
  let vfcHandle = 0;
  let rafHandle = 0;

  const ensureWorkers = () => {
    while (workers.length < workerCount) {
      const w = new DecodeWorker();
      const slot = { w, busy: false };
      w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
        slot.busy = false;
        onResult(ev.data);
      };
      workers.push(slot);
    }
  };

  const onResult = (msg: WorkerResponse) => {
    if (done) return;
    const r = msg.result as FrameResult;
    frames++;
    windowFrames++;
    if (r.stage === 'decoded') {
      located++;
      tilesOk += r.tilesOk;
      tilesTotal += r.tilesTotal;
    }
    lastResult = r;
    if (r.payloads.length) {
      if (!firstPacketAt) firstPacketAt = performance.now();
      recv.add(r.payloads);
    }
    const now = performance.now();
    if (now - windowStart > 1000) {
      procFps = (windowFrames * 1000) / (now - windowStart);
      windowFrames = 0;
      windowStart = now;
    }
    drawOverlay();
    updateUi();
    if (recv.completed && !done) finish();
  };

  const updateUi = () => {
    const p = recv.progress();
    const r = lastResult;
    if (r) {
      status.textContent =
        r.stage === 'decoded' && r.format
          ? `Locked: ${r.format.width}×${r.format.height} cells, ${BPC_NAMES[r.format.bpc]} · ${r.tilesOk}/${r.tilesTotal} tiles this frame`
          : r.stage === 'no-format'
            ? 'Found corner markers, reading format…'
            : 'Searching for a code… fill the frame with the sender’s screen';
    }
    if (p) {
      const frac = Math.min(1, p.unique / Math.max(1, p.needed));
      fill.style.width = `${(frac * 100).toFixed(1)}%`;
      const elapsed = (performance.now() - (firstPacketAt || performance.now())) / 1000;
      const rate = elapsed > 0.5 ? (p.unique * SYMBOL_SIZE) / elapsed : 0;
      const remaining = Math.max(0, p.needed - p.unique) * SYMBOL_SIZE;
      fileLine.textContent = p.header ? `${p.header.name} · ${formatBytes(p.header.size)}` : `Incoming transfer · ${formatBytes(p.transferLength)}`;
      stats.textContent =
        `${p.unique}/${p.needed} packets · ${formatRate(rate)} · ETA ${rate > 0 ? formatDuration(remaining / rate) : '—'} · ` +
        `${procFps.toFixed(0)} fps decoded · ${located}/${frames} frames locked · ${tilesTotal ? ((100 * tilesOk) / tilesTotal).toFixed(0) : 0}% tiles ok`;
    } else {
      stats.textContent = `${procFps.toFixed(0)} fps decoded · ${located}/${frames} frames locked`;
    }
  };

  const drawOverlay = () => {
    const rect = viewport.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (overlay.width !== Math.round(rect.width * dpr) || overlay.height !== Math.round(rect.height * dpr)) {
      overlay.width = Math.round(rect.width * dpr);
      overlay.height = Math.round(rect.height * dpr);
    }
    const ctx = overlay.getContext('2d')!;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const r = lastResult;
    const vw = lastResultSize.w, vh = lastResultSize.h;
    if (!r || !vw || !vh) return;
    // object-fit: contain mapping from video pixels to overlay pixels.
    const s = Math.min(overlay.width / vw, overlay.height / vh);
    const ox = (overlay.width - vw * s) / 2, oy = (overlay.height - vh * s) / 2;
    const map = (x: number, y: number) => [ox + x * s, oy + y * s] as const;
    ctx.lineWidth = 3 * dpr;
    if (r.corners) {
      ctx.strokeStyle = r.tilesOk > 0 ? '#33d17a' : '#f6c343';
      ctx.beginPath();
      r.corners.forEach((c, i) => {
        const [x, y] = map(c.x, c.y);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.stroke();
    } else {
      ctx.fillStyle = '#f6c343';
      for (const f of r.finders.slice(0, 8)) {
        const [x, y] = map(f.x, f.y);
        ctx.beginPath();
        ctx.arc(x, y, 6 * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };

  const pump = () => {
    if (!running || done) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (vw && vh && video.readyState >= 2) {
      const slot = workers.find((w) => !w.busy);
      if (slot) {
        slot.busy = true;
        lastResultSize = { w: vw, h: vh };
        const id = nextId++;
        if (useBitmap) {
          createImageBitmap(video)
            .then((bitmap) => slot.w.postMessage({ kind: 'bitmap', id, bitmap } satisfies WorkerRequest, [bitmap]))
            .catch(() => (slot.busy = false));
        } else {
          if (grab.width !== vw || grab.height !== vh) {
            grab.width = vw;
            grab.height = vh;
          }
          grabCtx.drawImage(video, 0, 0);
          const data = grabCtx.getImageData(0, 0, vw, vh);
          slot.w.postMessage({ kind: 'pixels', id, width: vw, height: vh, buffer: data.data.buffer } satisfies WorkerRequest, [data.data.buffer]);
        }
      }
    }
    schedule();
  };

  const schedule = () => {
    if (!running) return;
    if ('requestVideoFrameCallback' in video) vfcHandle = video.requestVideoFrameCallback(() => pump());
    else rafHandle = requestAnimationFrame(() => pump());
  };

  const begin = () => {
    ensureWorkers();
    running = true;
    schedule();
  };

  const stopMedia = () => {
    running = false;
    if (vfcHandle && 'cancelVideoFrameCallback' in video) video.cancelVideoFrameCallback(vfcHandle);
    cancelAnimationFrame(rafHandle);
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  };

  const openCamera = async (deviceId?: string) => {
    err.textContent = '';
    stopMedia();
    try {
      await initFountain(wasmUrl);
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }),
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
      });
    } catch (e) {
      err.textContent = `Camera unavailable: ${(e as Error).message}. Camera access needs HTTPS (or localhost) and permission.`;
      return;
    }
    video.srcObject = stream;
    await video.play().catch(() => {});
    const track = stream.getVideoTracks()[0];
    try {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] });
    } catch {
      /* unsupported */
    }
    const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { zoom?: { min: number; max: number; step: number } };
    if (caps.zoom && caps.zoom.max > caps.zoom.min) {
      zoom.hidden = false;
      zoom.min = String(caps.zoom.min);
      zoom.max = String(caps.zoom.max);
      zoom.step = String(caps.zoom.step || 0.1);
      zoom.value = String((track.getSettings() as { zoom?: number }).zoom ?? caps.zoom.min);
      zoom.oninput = () => track.applyConstraints({ advanced: [{ zoom: Number(zoom.value) } as MediaTrackConstraintSet] }).catch(() => {});
    } else zoom.hidden = true;
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    if (devices.length > 1) {
      camSelect.hidden = false;
      const current = track.getSettings().deviceId;
      camSelect.replaceChildren(...devices.map((d, i) => h('option', { value: d.deviceId, selected: d.deviceId === current }, d.label || `Camera ${i + 1}`)));
    }
    startBtn.hidden = true;
    resetBtn.hidden = false;
    status.textContent = 'Searching for a code…';
    begin();
  };

  const finish = async () => {
    done = true;
    stopMedia();
    const c = recv.completed!;
    result.hidden = false;
    fill.style.width = '100%';
    try {
      const file = await unpackFile(c.bytes);
      const blob = new Blob([file.data as BlobPart], { type: file.mime || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const secs = (performance.now() - (firstPacketAt || performance.now())) / 1000;
      const children: Node[] = [
        h('h2', {}, file.crcOk ? 'Received' : 'Received (checksum mismatch!)'),
        h('p', {}, `${file.name} · ${formatBytes(file.data.length)} in ${formatDuration(secs)} (${formatRate(file.data.length / Math.max(secs, 0.001))})`),
      ];
      if (file.mime.startsWith('image/')) children.push(h('img', { src: url, alt: file.name, class: 'preview' }));
      else if (file.mime.startsWith('text/')) {
        const pre = h('pre', { class: 'preview' });
        pre.textContent = new TextDecoder().decode(file.data.subarray(0, 20000));
        children.push(pre);
      }
      const actions = h('div', { class: 'row' }, h('a', { class: 'button', href: url, download: file.name }, 'Save file'));
      const shareFile = new File([blob], file.name, { type: blob.type });
      if (navigator.canShare?.({ files: [shareFile] })) {
        const sb = h('button', { type: 'button', class: 'secondary' }, 'Share…');
        sb.addEventListener('click', () => navigator.share({ files: [shareFile] }).catch(() => {}));
        actions.append(sb);
      }
      if (file.mime.startsWith('text/')) {
        const cb = h('button', { type: 'button', class: 'secondary' }, 'Copy text');
        cb.addEventListener('click', () => navigator.clipboard?.writeText(new TextDecoder().decode(file.data)).catch(() => {}));
        actions.append(cb);
      }
      children.push(actions);
      result.replaceChildren(...children);
      status.textContent = 'Done. You can close the camera.';
      // Read by the E2E test.
      (window as unknown as { __airhopResult?: unknown }).__airhopResult = { name: file.name, size: file.data.length, crcOk: file.crcOk, frames, secs };
    } catch (e) {
      result.replaceChildren(h('h2', {}, 'Transfer failed'), h('p', {}, (e as Error).message));
    }
  };

  const reset = () => {
    recv.reset();
    done = false;
    lastResult = null;
    frames = located = tilesOk = tilesTotal = 0;
    firstPacketAt = 0;
    fill.style.width = '0%';
    fileLine.textContent = '';
    result.hidden = true;
    result.replaceChildren();
    if (!stream && !video.src) {
      startBtn.hidden = false;
      resetBtn.hidden = true;
    } else if (stream) begin();
  };

  startBtn.addEventListener('click', () => openCamera());
  camSelect.addEventListener('change', () => openCamera(camSelect.value));
  resetBtn.addEventListener('click', () => {
    const hadStream = !!stream || done;
    reset();
    if (hadStream && !stream) openCamera(camSelect.value || undefined);
  });
  videoFile.addEventListener('change', async () => {
    const f = videoFile.files?.[0];
    if (!f) return;
    stopMedia();
    await initFountain(wasmUrl);
    video.srcObject = null;
    video.src = URL.createObjectURL(f);
    video.playbackRate = 0.5;
    video.loop = true;
    await video.play().catch(() => {});
    startBtn.hidden = true;
    resetBtn.hidden = false;
    begin();
  });

  // Automation hook: ?autostart starts the camera without a click (used by the E2E test).
  if (new URLSearchParams(location.search).has('autostart')) openCamera();

  return () => {
    stopMedia();
    workers.forEach((w) => w.w.terminate());
    view.remove();
  };
}
