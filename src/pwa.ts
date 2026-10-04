// Service worker registration plus the small bits of install/offline UI on the home page.
import { h } from './ui/dom';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const supported = 'serviceWorker' in navigator && window.isSecureContext;
const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const state = {
  offlineReady: false,
  update: null as ServiceWorker | null,
  installPrompt: null as BeforeInstallPromptEvent | null,
};
let reloadOnControllerChange = false;

/** Persistent status line, re-attached to the home page footer each time it renders. */
export const pwaStatus = h('div', { class: 'pwa' });

function render(): void {
  const items: Node[] = [];
  if (state.update) {
    const b = h('button', { type: 'button' }, 'Update ready: reload');
    b.addEventListener('click', () => {
      reloadOnControllerChange = true;
      state.update?.postMessage('skipWaiting');
    });
    items.push(b);
  }
  if (state.installPrompt) {
    const b = h('button', { type: 'button', class: 'secondary' }, 'Install app');
    b.addEventListener('click', async () => {
      const p = state.installPrompt;
      state.installPrompt = null;
      render();
      await p?.prompt();
    });
    items.push(b);
  } else if (ios && !standalone && supported) {
    items.push(h('span', {}, 'To install: Share → Add to Home Screen'));
  }
  if (supported) items.push(h('span', { class: state.offlineReady ? 'ok' : '' }, state.offlineReady ? '✓ Works offline' : 'Preparing offline use…'));
  pwaStatus.replaceChildren(...items);
}

export function initPwa(): void {
  render();
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installPrompt = e as BeforeInstallPromptEvent;
    render();
  });
  window.addEventListener('appinstalled', () => {
    state.installPrompt = null;
    render();
  });
  if (!import.meta.env.PROD || !supported) return;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Only reload when the user asked for the update; the first install also changes controller.
    if (reloadOnControllerChange) location.reload();
  });
  navigator.serviceWorker
    .register('./sw.js')
    .then((reg) => {
      const offer = (w: ServiceWorker) => {
        state.update = w;
        render();
      };
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
        });
      });
      // Installed apps can stay open for days: look for a new version when brought to the front.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    })
    .catch(() => {});
  // `ready` resolves once a worker is active, i.e. after the whole app has been precached.
  navigator.serviceWorker.ready.then(() => {
    state.offlineReady = true;
    render();
    // Ask the browser not to evict the offline copy under storage pressure (granted automatically
    // for installed apps in Chromium; a no-op where unsupported).
    navigator.storage?.persist?.().catch(() => {});
  });
}
