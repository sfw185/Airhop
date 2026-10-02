import { ECC_NAMES, MAX_DIM, MIN_DIM, SYMBOL_SIZE, type BitsPerCell, type EccLevel } from '../core/format';
import { initFountain } from '../core/fountain';
import { getLayout, type Layout } from '../core/layout';
import { packFile, SendSession } from '../core/transfer';
import { formatBytes, formatDuration, formatRate, h } from './dom';
import { FrameRenderer, QUIET } from './render';
import wasmUrl from 'raptorq/raptorq_bg.wasm?url';
import { renderSVG } from 'uqr';

interface Settings {
  density: number;
  bpc: BitsPerCell;
  ecc: EccLevel;
  fps: number;
}

const DENSITIES: [string, number][] = [
  ['Low', 96],
  ['Medium', 160],
  ['High', 224],
  ['Very high', 288],
  ['Max', 352],
];

const STORAGE_KEY = 'airhop.send.settings';

function loadSettings(): Settings {
  const d: Settings = { density: 160, bpc: 2, ecc: 1, fps: 10 };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') };
  } catch {
    return d;
  }
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

/** A QR code that opens the receiver on another device (most phone cameras read QR natively). */
function receiverLink(): HTMLElement | null {
  if (!/^https?:$/.test(location.protocol)) return null;
  const url = `${location.origin}${location.pathname}#receive`;
  const svg = renderSVG(url, { border: 2, pixelSize: 4 });
  return h(
    'div',
    { class: 'receiver-link' },
    h('img', { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, alt: 'QR code linking to the receiver', width: 132, height: 132 }),
    h('div', {}, h('strong', {}, 'Receiving on a phone?'), h('span', {}, 'Scan this with its camera to open the receiver, or visit '), h('code', {}, url)),
  );
}

const round8 = (v: number) => Math.min(MAX_DIM, Math.max(MIN_DIM, Math.round(v / 8) * 8));

export function mountSend(root: HTMLElement): () => void {
  let stop: (() => void) | null = null;
  const settings = loadSettings();

  const fileInput = h('input', { type: 'file', id: 'file', class: 'visually-hidden' }) as HTMLInputElement;
  const text = h('textarea', { placeholder: '…or paste text to send', rows: 4 }) as HTMLTextAreaElement;
  const err = h('p', { class: 'error', role: 'alert' });
  const drop = h(
    'label',
    { class: 'drop', for: 'file' },
    h('strong', {}, 'Choose a file'),
    h('span', {}, 'or drop it here'),
  );
  const sendText = h('button', { class: 'secondary', type: 'button' }, 'Send text');
  const setup = h(
    'main',
    { class: 'panel' },
    h('nav', {}, h('a', { href: '#' }, '← Airhop'), h('span', { class: 'title' }, 'Send')),
    fileInput,
    drop,
    text,
    sendText,
    err,
    h('p', { class: 'hint' }, 'Keep this screen bright and in view of the receiving camera. Larger is better: go fullscreen once the code is running.'),
    receiverLink(),
  );
  root.append(setup);

  const start = async (name: string, mime: string, data: Uint8Array) => {
    err.textContent = '';
    drop.classList.add('busy');
    try {
      await initFountain(wasmUrl);
      const transfer = await packFile({ name, mime, data });
      const session = new SendSession(transfer);
      setup.remove();
      stop = run(root, { name, size: data.length }, transfer.length, session, settings, () => {
        stop?.();
        stop = null;
        root.append(setup);
      });
    } catch (e) {
      err.textContent = `Could not prepare the file: ${(e as Error).message}`;
    } finally {
      drop.classList.remove('busy');
    }
  };

  const pickFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 64 * 1024 * 1024) {
      err.textContent = 'That file is over 64 MB; at camera speeds it would take a very long time.';
      return;
    }
    await start(f.name, f.type, new Uint8Array(await f.arrayBuffer()));
  };
  fileInput.addEventListener('change', () => pickFile(fileInput.files?.[0]));
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    pickFile(e.dataTransfer?.files[0]);
  });
  sendText.addEventListener('click', () => {
    const t = text.value;
    if (!t.trim()) {
      err.textContent = 'Type or paste some text first.';
      return;
    }
    start('message.txt', 'text/plain;charset=utf-8', new TextEncoder().encode(t));
  });

  return () => {
    stop?.();
    setup.remove();
  };
}

function run(
  root: HTMLElement,
  file: { name: string; size: number },
  transferLength: number,
  session: SendSession,
  settings: Settings,
  onClose: () => void,
): () => void {
  const canvas = h('canvas', { class: 'code', 'aria-label': 'Animated transfer code' }) as HTMLCanvasElement;
  const stage = h('div', { class: 'stage' }, canvas);
  const sel = <T extends string | number>(label: string, options: [string, T][], value: T, onChange: (v: T) => void) => {
    const s = h('select', { 'aria-label': label }) as HTMLSelectElement;
    for (const [name, v] of options) s.append(h('option', { value: String(v), selected: v === value }, name));
    s.addEventListener('change', () => onChange((typeof value === 'number' ? Number(s.value) : s.value) as T));
    return h('label', { class: 'ctl' }, h('span', {}, label), s);
  };
  const fpsOut = h('output', {}, String(settings.fps));
  const fps = h('input', { type: 'range', min: 2, max: 30, step: 1, value: settings.fps, 'aria-label': 'Frames per second' }) as HTMLInputElement;
  const info = h('div', { class: 'info' });
  const warn = h('div', { class: 'warn', role: 'status' });
  const fsBtn = h('button', { type: 'button', class: 'secondary' }, 'Fullscreen');
  const closeBtn = h('button', { type: 'button', class: 'secondary' }, 'Stop');
  const bar = h(
    'div',
    { class: 'toolbar' },
    h('div', { class: 'file' }, h('strong', {}, file.name), h('span', {}, `${formatBytes(file.size)} → ${formatBytes(transferLength)} after packing`)),
    h(
      'div',
      { class: 'controls' },
      sel('Density', DENSITIES.map(([n, v]) => [n, v] as [string, number]), settings.density, (v) => {
        settings.density = v;
        relayout();
      }),
      sel('Colours', [['2', 1], ['4', 2], ['8', 3]] as [string, number][], settings.bpc, (v) => {
        settings.bpc = v as BitsPerCell;
        relayout();
      }),
      sel('ECC', ECC_NAMES.map((n, i) => [n, i] as [string, number]), settings.ecc, (v) => {
        settings.ecc = v as EccLevel;
        relayout();
      }),
      h('label', { class: 'ctl' }, h('span', {}, 'FPS'), fps, fpsOut),
      fsBtn,
      closeBtn,
    ),
    info,
    warn,
  );
  const view = h('div', { class: 'sender' }, bar, stage);
  root.append(view);

  let layout: Layout | null = null;
  let renderer: FrameRenderer | null = null;
  let raf = 0;
  let lastFrame = 0;
  let shown = 0;
  let shownSince = performance.now();
  let measuredFps = 0;
  let wakeLock: WakeLockSentinel | null = null;

  const relayout = () => {
    saveSettings(settings);
    const dpr = window.devicePixelRatio || 1;
    const rect = stage.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    const aw = Math.max(1, canvas.width), ah = Math.max(1, canvas.height);
    const d = settings.density;
    let W: number, Hh: number;
    if (aw >= ah) {
      W = round8(d);
      Hh = round8(((d + 2 * QUIET) * ah) / aw - 2 * QUIET);
    } else {
      Hh = round8(d);
      W = round8(((d + 2 * QUIET) * aw) / ah - 2 * QUIET);
    }
    layout = getLayout({ width: W, height: Hh, bpc: settings.bpc, ecc: settings.ecc });
    renderer = new FrameRenderer(layout);
    const px = renderer.scaleFor(canvas);
    warn.textContent =
      layout.tiles.length === 0
        ? 'This grid is too small to carry data. Raise the density or colours.'
        : px < 2
          ? `Cells are only ${px}px on this screen. Lower the density or go fullscreen.`
          : '';
    updateInfo();
  };

  const updateInfo = () => {
    if (!layout) return;
    const perFrame = layout.payloadPerFrame;
    const rate = perFrame * settings.fps;
    const frames = Math.ceil(Math.ceil(transferLength / SYMBOL_SIZE) / Math.max(1, layout.tiles.length));
    info.textContent =
      `${layout.W}×${layout.H} cells · ${layout.tiles.length} packets/frame (${formatBytes(perFrame)}) · ` +
      `up to ${formatRate(rate)} · ≥${frames} frames (${formatDuration(frames / settings.fps)}) · ` +
      `showing ${measuredFps.toFixed(0)} fps · ${session.emitted} packets sent`;
  };

  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    if (!layout || !renderer || layout.tiles.length === 0) return;
    const interval = 1000 / settings.fps;
    // Frames change on vsync boundaries; the small slack keeps e.g. 10 fps at exactly 6 vsyncs.
    if (now - lastFrame < interval - 4) return;
    lastFrame = now;
    renderer.draw(canvas, session.next(layout.tiles.length));
    shown++;
    if (now - shownSince > 1000) {
      measuredFps = (shown * 1000) / (now - shownSince);
      shown = 0;
      shownSince = now;
      updateInfo();
    }
  };

  fps.addEventListener('input', () => {
    settings.fps = Number(fps.value);
    fpsOut.textContent = fps.value;
    saveSettings(settings);
    updateInfo();
  });
  fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else stage.requestFullscreen?.().catch(() => {});
  });
  closeBtn.addEventListener('click', () => onClose());
  const ro = new ResizeObserver(() => relayout());
  ro.observe(stage);
  const onVis = async () => {
    if (document.visibilityState === 'visible' && 'wakeLock' in navigator) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
      } catch {
        /* not allowed */
      }
    }
  };
  document.addEventListener('visibilitychange', onVis);
  onVis();
  relayout();
  raf = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    document.removeEventListener('visibilitychange', onVis);
    wakeLock?.release().catch(() => {});
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    view.remove();
  };
}
