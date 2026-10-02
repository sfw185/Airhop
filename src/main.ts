import './ui/style.css';
import { h } from './ui/dom';
import { mountReceive } from './ui/receive';
import { mountSend } from './ui/send';
import workerUrl from './ui/decode.worker?worker&url';
import wasmUrl from 'raptorq/raptorq_bg.wasm?url';

const app = document.getElementById('app')!;
let unmount: (() => void) | null = null;

function home(): HTMLElement {
  return h(
    'main',
    { class: 'home' },
    h('div', { class: 'brand' }, h('span', { class: 'logo', 'aria-hidden': 'true' }), h('h1', {}, 'Airhop')),
    h('p', { class: 'lede' }, 'Move files between devices with a screen and a camera. No network, no pairing, no install. Everything runs in this page.'),
    h(
      'div',
      { class: 'choices' },
      h('a', { class: 'choice', href: '#send' }, h('strong', {}, 'Send'), h('span', {}, 'Show a file as a stream of colour codes')),
      h('a', { class: 'choice', href: '#receive' }, h('strong', {}, 'Receive'), h('span', {}, 'Point this device’s camera at the sender')),
    ),
    h(
      'details',
      { class: 'how' },
      h('summary', {}, 'How it works'),
      h(
        'p',
        {},
        'The sender splits the file with a RaptorQ fountain code, so the receiver can start at any time and never needs a particular frame, only enough of them. ',
        'Each frame is a grid of 2, 4 or 8 colour cells, cut into tiles that each carry one Reed–Solomon-protected packet, so a glare spot or a rolling-shutter seam costs only the tiles it touches. ',
        'Finder, alignment and colour-reference patterns let the receiver correct perspective, lens distortion and colour casts.',
      ),
    ),
    h('footer', {}, h('a', { href: 'https://github.com/sfw185/airhop' }, 'Source'), ' · nothing is uploaded'),
  );
}

function route(): void {
  unmount?.();
  unmount = null;
  app.replaceChildren();
  const r = location.hash.replace('#', '');
  if (r === 'send') unmount = mountSend(app);
  else if (r === 'receive') unmount = mountReceive(app);
  else app.append(home());
}

window.addEventListener('hashchange', route);
route();

if (import.meta.env.PROD && 'serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker
    .register('./sw.js')
    // Warm the cache with the lazily loaded pieces so both modes work offline later.
    .then(() => Promise.all([wasmUrl, workerUrl].map((u) => fetch(u).catch(() => {}))))
    .catch(() => {});
}
