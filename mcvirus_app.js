// Browser launcher and keyboard controls. Runtime code lives in mcvirus.js;
// this module is the only place that deliberately exposes compatibility hooks.
import MCVirus, { start } from './mcvirus.js';

const canvas = document.getElementById('c');
const ui = document.getElementById('ui');
const status = document.getElementById('status');
const startButton = document.getElementById('go');

let app = null;
let wakeLock = null;
let flashTimer = 0;

function setApp(value) {
  app = value;
  globalThis.__app = value;
}

function setStatus(text) {
  status.textContent = text || '';
}

function formatTime(seconds) {
  seconds = Math.max(0, Math.round(seconds || 0));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function flash(text) {
  setStatus(text);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    if (status.textContent === text) setStatus('');
  }, 1200);
}

async function lockScreen() {
  if (!('wakeLock' in navigator) || wakeLock) return;
  try {
    const lock = await navigator.wakeLock.request('screen');
    wakeLock = lock;
    lock.addEventListener('release', () => {
      if (wakeLock === lock) wakeLock = null;
    });
  } catch {
    wakeLock = null;
  }
}

function unlockScreen() {
  if (!wakeLock) return;
  wakeLock.release().catch(() => {});
  wakeLock = null;
}

function showLauncher() {
  ui.classList.remove('hidden');
  canvas.style.opacity = '0';
  setStatus('');
}

function restoreLauncherAfterError(error) {
  console.error(error);
  setApp(null);
  unlockScreen();
  ui.classList.remove('hidden');
  canvas.style.opacity = '0';
}

function begin() {
  if (app) return;
  ui.classList.add('hidden');
  canvas.style.opacity = '1';

  try {
    setApp(start(canvas, setStatus, {
      onStart: lockScreen,
      onEnd: () => {
        setApp(null);
        unlockScreen();
        showLauncher();
      },
      onError: restoreLauncherAfterError,
    }));
  } catch (error) {
    restoreLauncherAfterError(error);
    setStatus(error.message || String(error));
  }
}

function stop() {
  if (app) app.stop();
}

startButton.addEventListener('click', begin);

addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();

  if (event.key === 'Escape') {
    stop();
    return;
  }

  if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && app) {
    event.preventDefault();
    const backwards = event.key === 'ArrowLeft';
    const time = app.seek(backwards ? -5 : 5);
    flash(`${backwards ? '◀' : '▶'} ${formatTime(time)}`);
    return;
  }

  if (event.key === ' ' && !app) {
    event.preventDefault();
    begin();
  } else if (event.key === ' ' && app) {
    event.preventDefault();
    flash(app.pause() ? 'paused' : 'playing');
  }

  if (key === 'f' && !event.repeat && document.fullscreenEnabled) {
    const action = document.fullscreenElement
      ? document.exitFullscreen()
      : document.documentElement.requestFullscreen();
    Promise.resolve(action).catch(() => {});
  }
});

document.addEventListener('visibilitychange', () => {
  if (!app || document.visibilityState !== 'visible') return;
  app.wake();
  lockScreen();
});

// Kept for the existing browser-validation workflow and console exploration.
globalThis.MCVirus = MCVirus;
globalThis.__validationReady = true;
globalThis.__app = null;

showLauncher();
