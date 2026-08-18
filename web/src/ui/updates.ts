/**
 * The update button: a circular arrow in the app bar, with a green dot when a
 * newer version is waiting.
 *
 * Deliberately never checks in the background. A service worker cannot run when
 * the app is closed unless it is given Periodic Background Sync or push, and it
 * is given neither — the only checks are the one at startup, one when the app
 * comes back to the foreground, and whatever the user asks for by pressing the
 * button. Nothing is fetched about this app while it is not open.
 *
 * The service worker installs a new version and then waits, rather than taking
 * over on its own, so the swap happens when the user presses the button and not
 * in the middle of an edit.
 */

/** Long enough that switching between apps does not hammer the server. */
const FOREGROUND_CHECK_INTERVAL = 15 * 60 * 1000;

interface UpdateDom {
  button: HTMLButtonElement;
  dot: HTMLElement;
  icon: HTMLElement;
  version: HTMLElement;
}

type Report = (message: string) => void;

let dom: UpdateDom | null = null;
let registration: ServiceWorkerRegistration | null = null;
let waiting: ServiceWorker | null = null;
let lastCheck = 0;
let checking = false;
let reloading = false;
let report: Report = () => {};
let confirmReload: () => boolean = () => true;

export function initUpdates(options: {
  version: string;
  toast: Report;
  /** Returns false to hold off reloading — an edit is in progress. */
  confirmReload(): boolean;
}): void {
  report = options.toast;
  confirmReload = options.confirmReload;

  dom = {
    button: required<HTMLButtonElement>('update-button'),
    dot: required('update-dot'),
    icon: required('update-icon'),
    version: required('version-label'),
  };

  dom.version.textContent = `v${options.version}`;
  dom.button.addEventListener('click', () => void onPress());

  if (!('serviceWorker' in navigator)) {
    // Nothing to update against: the app is running straight from the network.
    dom.button.hidden = true;
    return;
  }

  window.addEventListener('load', () => void register(options.version));

  // Coming back to the app is the natural moment to look, and it is still the
  // app being open — which is the only time this checks at all.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastCheck < FOREGROUND_CHECK_INTERVAL) return;
    void check({ quiet: true });
  });

  // The new worker has taken over; the page has to reload to run its code.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloading) return;
    window.location.reload();
  });
}

async function register(version: string): Promise<void> {
  try {
    registration = await navigator.serviceWorker.register('sw.js');
  } catch {
    // Registration fails on file:// and in some private modes; the app runs on.
    if (dom) dom.button.hidden = true;
    return;
  }

  void showBuild(version);

  // An update may already have been downloaded and be waiting from last time.
  if (registration.waiting && navigator.serviceWorker.controller) setWaiting(registration.waiting);

  registration.addEventListener('updatefound', () => {
    const installing = registration?.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      // Without a controller this is the very first install, not an update.
      if (installing.state === 'installed' && navigator.serviceWorker.controller) {
        setWaiting(installing);
      }
    });
  });

  void check({ quiet: true });
}

/* ------------------------------------------------------------- the button */

async function onPress(): Promise<void> {
  // Two jobs, in the order the user means them: apply a ready update, or go
  // and look for one.
  if (waiting) {
    applyUpdate();
    return;
  }
  await check({ quiet: false });
}

function applyUpdate(): void {
  if (!waiting) return;
  if (!confirmReload()) return;

  reloading = true;
  report('Updating…');
  waiting.postMessage({ type: 'skip-waiting' });

  // If the worker never takes over, do not leave the user staring at a spinner.
  window.setTimeout(() => {
    if (reloading) window.location.reload();
  }, 4000);
}

async function check({ quiet }: { quiet: boolean }): Promise<void> {
  if (!registration || checking) return;

  checking = true;
  lastCheck = Date.now();
  dom?.button.classList.add('update--checking');

  try {
    await registration.update();
    // `update()` resolves before a new worker finishes installing, so give the
    // statechange listener a moment before saying there is nothing new.
    await new Promise((resolve) => setTimeout(resolve, 900));
    if (!quiet && !waiting) report('You are on the latest version.');
  } catch {
    if (!quiet) {
      report(
        navigator.onLine
          ? 'Could not check for an update just now.'
          : 'No connection — the app keeps working, and will check when you are back online.'
      );
    }
  } finally {
    checking = false;
    dom?.button.classList.remove('update--checking');
  }
}

function setWaiting(worker: ServiceWorker): void {
  waiting = worker;
  if (!dom) return;

  dom.dot.hidden = false;
  dom.button.classList.add('update--ready');
  dom.button.title = 'An update is ready — press to install it';
  dom.button.setAttribute('aria-label', 'An update is ready. Press to install it.');
  report('A new version is ready. Press ↻ to install it.');
}

/* ------------------------------------------------------------- the version */

/**
 * The running build, asked of the worker that is actually serving the app —
 * the cache name is a content hash, so it is the one answer that cannot drift
 * from what is on screen.
 */
async function showBuild(version: string): Promise<void> {
  const controller = navigator.serviceWorker.controller;
  if (!controller || !dom) return;

  try {
    const build = await new Promise<string>((resolve, reject) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => reject(new Error('no answer')), 1500);
      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        resolve(String((event.data as { version?: string })?.version ?? ''));
      };
      controller.postMessage({ type: 'version' }, [channel.port2]);
    });

    const hash = build.replace(/^md-converter-/, '').slice(0, 7);
    if (hash) dom.version.textContent = `v${version} · build ${hash}`;
  } catch {
    // An older worker with no version handler; the plain version stands.
  }
}

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}
