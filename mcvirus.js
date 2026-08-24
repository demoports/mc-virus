// Canvas2D presentation, live Krawall/Web Audio playback, and validation API.
import {
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
  AUDIO_SAMPLE_RATE,
  AUDIO_DURATION_SECONDS,
  GBA_FRAMES_PER_SECOND,
  KRAP_PLAY_SAMPLE,
} from './mcvirus_constants.js';
import {
  Assets,
  Framebuffer,
  base64Bytes,
  loadAssets,
  syncAt,
} from './mcvirus_core.js';
import { Renderer, cameraAt } from './mcvirus_engine.js';
import { Effects, createEffects } from './mcvirus_fx.js';
import { AudioPlayer } from './mcvirus_audio.js';

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([0x0a0b0c0d]).buffer)[0] === 0x0d;
const runtimes = new WeakMap();
let previewGeneration = 0;

function resolveCanvas(value) {
  if (typeof value === 'string' && typeof document !== 'undefined') {
    value = document.querySelector(value);
  }
  if (!value && typeof document !== 'undefined') {
    value = document.getElementById('c');
  }
  if (!value || typeof value.getContext !== 'function') throw new Error('A canvas is required.');
  return value;
}

export class CanvasOutput {
  constructor(canvas) {
    this.canvas = canvas;
    canvas.width = SCREEN_WIDTH;
    canvas.height = SCREEN_HEIGHT;
    this.context = canvas.getContext('2d', { alpha: false });
    if (!this.context) throw new Error('Canvas2D is required to display mc-virus.');
    this.context.imageSmoothingEnabled = false;
    this.image = this.context.createImageData(SCREEN_WIDTH, SCREEN_HEIGHT);
    this.words = new Uint32Array(this.image.data.buffer);
  }

  present(framebuffer) {
    const rgba = framebuffer.toRGBA();
    if (LITTLE_ENDIAN) this.words.set(rgba);
    else {
      const bytes = this.image.data;
      for (let i = 0; i < rgba.length; ++i) {
        const color = rgba[i], at = i * 4;
        bytes[at] = color & 255;
        bytes[at + 1] = (color >>> 8) & 255;
        bytes[at + 2] = (color >>> 16) & 255;
        bytes[at + 3] = 255;
      }
    }
    this.context.putImageData(this.image, 0, 0);
  }

  clear() {
    this.context.fillStyle = '#000';
    this.context.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
  }
}

function runtimeFor(canvas) {
  canvas = resolveCanvas(canvas);
  let promise = runtimes.get(canvas);
  if (!promise) {
    const output = new CanvasOutput(canvas);
    promise = loadAssets()
      .then((assets) => ({
        canvas,
        output,
        assets,
        effects: new Effects(assets),
        lastFrame: -1,
      }))
      .catch((error) => {
        runtimes.delete(canvas);
        throw error;
      });
    runtimes.set(canvas, promise);
  }
  return promise;
}

function renderSeconds(runtime, seconds, force) {
  seconds = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const frame = Math.max(0, Math.floor(seconds * GBA_FRAMES_PER_SECOND + 1e-7));
  if (!force && frame === runtime.lastFrame) return runtime.effects.fb;
  const framebuffer = runtime.effects.renderAt(frame / GBA_FRAMES_PER_SECOND) || runtime.effects.fb;
  if (!framebuffer || typeof framebuffer.toRGBA !== 'function') {
    throw new Error('Effects.renderAt() did not return a Framebuffer.');
  }
  runtime.output.present(framebuffer);
  runtime.lastFrame = frame;
  return framebuffer;
}

// Render a live frame behind the launcher. It uses the same ROM assets and
// Canvas2D path as playback, but never constructs an AudioContext.
export function preview(canvas, seconds, done) {
  const generation = ++previewGeneration;
  return runtimeFor(canvas).then((runtime) => {
    if (generation !== previewGeneration) return null;
    const framebuffer = renderSeconds(runtime, seconds, true);
    if (done) done(null, framebuffer);
    return framebuffer;
  }).catch((error) => {
    if (done) done(error);
    else console.error(error);
    return null;
  });
}

export function cancelPreview() { ++previewGeneration; }

// options.onStart(app), options.onEnd(natural), options.onError(error), and
// options.onTime(seconds, duration, paused) are all optional. The returned
// controller is immediate, allowing Escape to cancel while assets decode.
export function start(canvas, setStatus, options = {}) {
  canvas = resolveCanvas(canvas);
  const status = typeof setStatus === 'function' ? setStatus : () => {};
  cancelPreview();

  let running = true;
  let loaded = false;
  let paused = false;
  let pendingTime = Math.max(0, Number(options.startTime) || 0);
  let runtime = null;
  let raf = 0;
  let lastHudTime = -Infinity;
  let readyPromise = null;

  const audio = new AudioPlayer({
    onended: () => finish(true),
    onerror: reportError,
  });

  function notifyTime(force) {
    if (!options.onTime) return;
    const now = loaded ? audio.time() : pendingTime;
    if (force || now - lastHudTime >= 0.2 || now < lastHudTime) {
      lastHudTime = now;
      options.onTime(now, audio.duration || 0, paused);
    }
  }

  function drawAt(seconds, force) {
    if (!runtime) return null;
    return renderSeconds(runtime, seconds, force);
  }

  function frame() {
    if (!running || !loaded) return;
    const seconds = audio.time();
    drawAt(seconds, false);
    notifyTime(false);
    raf = requestAnimationFrame(frame);
  }

  function finish(natural, fromError) {
    if (!running) return;
    running = false;
    cancelAnimationFrame(raf);
    audio.stop();
    if (fromError) return;
    status('');
    if (options.onEnd) options.onEnd(!!natural);
  }

  function reportError(error) {
    if (!running) return;
    status(error && error.message ? error.message : String(error));
    finish(false, true);
    if (options.onError) options.onError(error);
    else console.error(error);
  }

  const api = {
    stop: () => finish(false),
    pause() {
      paused = !paused;
      if (paused) audio.pause();
      else audio.resume().catch(reportError);
      if (loaded) drawAt(audio.time(), true);
      notifyTime(true);
      return paused;
    },
    seek(delta) {
      const current = audio.time();
      const limit = audio.duration || Number.POSITIVE_INFINITY;
      pendingTime = Math.max(0, Math.min(current + (Number(delta) || 0), limit));
      audio.seek(pendingTime);
      if (loaded) drawAt(pendingTime, true);
      notifyTime(true);
      return pendingTime;
    },
    time: () => audio.time(),
    wake: () => {
      if (!paused) audio.ensureRunning().catch(reportError);
    },
    get paused() { return paused; },
    get duration() { return audio.duration || 0; },
    get effects() { return runtime && runtime.effects; },
    get audio() { return audio; },
    get ready() { return readyPromise; },
  };

  status('unpacking cartridge data · loading song…');
  const playbackReady = audio.start(pendingTime);
  readyPromise = Promise.all([runtimeFor(canvas), playbackReady]).then((result) => {
    if (!running) return api;
    runtime = result[0];
    loaded = true;
    pendingTime = audio.time();
    drawAt(audio.time(), true);
    status('');
    notifyTime(true);
    if (options.onStart) options.onStart(api);
    raf = requestAnimationFrame(frame);
    return api;
  }).catch((error) => {
    reportError(error);
    return api;
  });

  return api;
}

// Deterministic validation: no audio, RAF, or wall clock. The requested GBA
// frame is converted back to its exact presentation time and rendered once.
export const validation = {
  last: null,

  async renderFrame(frame, canvas) {
    frame = Math.max(0, Math.floor(Number(frame) || 0));
    const runtime = await runtimeFor(canvas);
    const seconds = frame / GBA_FRAMES_PER_SECOND;
    const framebuffer = runtime.effects.renderAt(seconds) || runtime.effects.fb;
    runtime.output.present(framebuffer);
    runtime.lastFrame = frame;
    validation.last = { frame, seconds, framebuffer, canvas: runtime.canvas };
    return framebuffer;
  },

  renderAt(seconds, canvas) {
    const frame = Math.max(0, Math.floor(
      (Number(seconds) || 0) * GBA_FRAMES_PER_SECOND + 1e-7
    ));
    return validation.renderFrame(frame, canvas);
  },

  prepare(canvas) {
    return runtimeFor(canvas);
  },
};

export {
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
  AUDIO_SAMPLE_RATE,
  AUDIO_DURATION_SECONDS,
  GBA_FRAMES_PER_SECOND,
  KRAP_PLAY_SAMPLE,
  Assets,
  Framebuffer,
  Renderer,
  cameraAt,
  Effects,
  createEffects,
  AudioPlayer,
  base64Bytes,
  loadAssets,
  syncAt,
};

const MCVirus = Object.freeze({
  W: SCREEN_WIDTH,
  H: SCREEN_HEIGHT,
  GBA_RATE: AUDIO_SAMPLE_RATE,
  AUDIO_DURATION: AUDIO_DURATION_SECONDS,
  GBA_FPS: GBA_FRAMES_PER_SECOND,
  KRAP_PLAY_SAMPLE,
  Assets,
  Framebuffer,
  Renderer,
  cameraAt,
  Effects,
  createEffects,
  AudioPlayer,
  CanvasOutput,
  base64Bytes,
  loadAssets,
  syncAt,
  preview,
  cancelPreview,
  start,
  validation,
});

export default MCVirus;
