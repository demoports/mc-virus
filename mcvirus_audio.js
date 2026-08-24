// AudioContext clock and AudioWorklet control for the original Krawall song.
// The public controller keeps soundtrack production out of the demo loop.
import {
  AUDIO_DURATION_SECONDS,
  AUDIO_SAMPLE_RATE,
} from './mcvirus_constants.js';

const MODULE_URL = new URL('./Module0.krw', import.meta.url);
const BANK_URL = new URL('./mc-virus.gba.krb', import.meta.url);
const WORKLET_URL = new URL('./mcvirus_krawall_worklet.js', import.meta.url);
const PROCESSOR_NAME = 'mcvirus-krawall';
const COMMAND_TIMEOUT_MS = 30000;
const ABSOLUTE_DURATION_SAMPLES = Math.round(
  AUDIO_DURATION_SECONDS * AUDIO_SAMPLE_RATE
);

function stoppedError() {
  return new Error('Audio playback has been stopped.');
}

function audioContextConstructor() {
  return globalThis.AudioContext || globalThis.webkitAudioContext || null;
}

async function fetchAsset(url, name, signal) {
  let response;
  try {
    response = await fetch(url, { signal });
  } catch (error) {
    if (error && error.name === 'AbortError') throw error;
    throw new Error(`Could not load the ${name}: ${error.message || error}.`);
  }
  if (!response.ok) {
    throw new Error(
      `Could not load the ${name}: HTTP ${response.status} ${response.statusText}.`
    );
  }
  return response.arrayBuffer();
}

export class AudioPlayer {
  constructor(options = {}) {
    this.onended = options.onended || null;
    this.onerror = options.onerror || null;

    this.context = null;
    this.node = null;
    this._closed = false;
    this._ready = false;
    this._loadPromise = null;
    this._abortLoad = null;
    this._suspendPromise = null;
    this._requestedTime = 0;
    this._wantsPlayback = false;
    this._clockRunning = false;
    this._clockTime = 0;
    this._clockContextTime = 0;
    this._clockToken = 0;
    this._activeTransportId = 0;
    this._requestId = 0;
    this._pending = new Map();
    this._fatalError = null;
  }

  load() {
    if (this._closed) return Promise.reject(stoppedError());
    if (this._ready) return Promise.resolve(this);
    if (this._loadPromise) return this._loadPromise;

    let context;
    try {
      context = this._ensureContext();
    } catch (error) {
      return Promise.reject(error);
    }

    const abort = new AbortController();
    this._abortLoad = abort;
    const worklet = context.audioWorklet.addModule(WORKLET_URL.href).catch((error) => {
      throw new Error(`Could not load the Krawall audio worklet: ${error.message || error}.`);
    });
    const assets = Promise.all([
      fetchAsset(MODULE_URL, 'Krawall module', abort.signal),
      fetchAsset(BANK_URL, 'Krawall instrument bank', abort.signal),
    ]);

    this._loadPromise = Promise.all([worklet, assets]).then(([, bytes]) => {
      if (this._closed) throw stoppedError();

      const [module, bank] = bytes;
      const node = new AudioWorkletNode(context, PROCESSOR_NAME, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: {
          nativeRate: AUDIO_SAMPLE_RATE,
          durationSamples: ABSOLUTE_DURATION_SAMPLES,
        },
      });
      this.node = node;
      node.port.onmessage = (event) => this._handleMessage(event.data);
      node.port.start();
      node.onprocessorerror = () => {
        this._fail(new Error('The Krawall audio worklet stopped unexpectedly.'));
      };
      node.connect(context.destination);

      return this._request('init', { module, bank }, [module, bank]);
    }).then(() => {
      if (this._closed) throw stoppedError();
      this._ready = true;
      this._abortLoad = null;
      return this;
    }).catch((error) => {
      abort.abort();
      this._abortLoad = null;
      if (this.node && !this._ready) {
        try { this.node.port.postMessage({ type: 'stop' }); } catch { /* closed port */ }
        this._disposeNode();
      }
      if (!this._closed) this._loadPromise = null;
      throw error;
    });

    return this._loadPromise;
  }

  // Construct and resume the context before awaiting any network/module work.
  // This call is made directly by the launcher's Start gesture and therefore
  // retains the browser's audio-unlock permission.
  start(seconds = 0) {
    if (this._closed) return Promise.reject(stoppedError());
    this._requestedTime = this._clamp(seconds);
    this._wantsPlayback = true;

    let context;
    let unlocked;
    try {
      context = this._ensureContext();
      unlocked = context.resume();
    } catch (error) {
      return Promise.reject(error);
    }

    return Promise.all([Promise.resolve(unlocked), this.load()])
      .then(() => {
        if (this._closed) throw stoppedError();
        if (!this._wantsPlayback) return;
        return this._playAt(this._requestedTime);
      })
      .then(() => this.time());
  }

  time() {
    if (!this._clockRunning || !this.context) return this._requestedTime;
    const elapsed = Math.max(0, this.context.currentTime - this._clockContextTime);
    this._requestedTime = this._clamp(this._clockTime + elapsed);
    return this._requestedTime;
  }

  pause() {
    this._requestedTime = this.time();
    this._wantsPlayback = false;
    this._clockRunning = false;
    this._activeTransportId = 0;
    ++this._clockToken;

    if (this.context && this.context.state !== 'closed') {
      this._suspendPromise = Promise.resolve(this.context.suspend())
        .catch((error) => this._backgroundError(error));
    }
    return true;
  }

  resume() {
    if (this._closed) return Promise.reject(stoppedError());
    if (this._fatalError) return Promise.reject(this._fatalError);
    if (!this._ready) return this.start(this._requestedTime).then(() => false);

    if (this._requestedTime >= this.duration) this._requestedTime = 0;
    this._wantsPlayback = true;
    const suspended = this._suspendPromise || Promise.resolve();
    this._suspendPromise = null;

    return suspended
      .then(() => {
        if (this._closed) throw stoppedError();
        if (!this._wantsPlayback) return false;
        return Promise.resolve(this.context.resume()).then(() => true);
      })
      .then((active) => {
        if (!active || !this._wantsPlayback) {
          if (this.context.state === 'running') {
            this._suspendPromise = Promise.resolve(this.context.suspend())
              .catch((error) => this._backgroundError(error));
          }
          return;
        }
        return this._playAt(this._requestedTime);
      })
      .then(() => false);
  }

  togglePause() {
    if (!this.paused) {
      this.pause();
      return Promise.resolve(true);
    }
    return this.resume();
  }

  seek(seconds) {
    const target = this._clamp(seconds);
    this._requestedTime = target;
    this._clockRunning = false;
    this._activeTransportId = 0;
    const token = ++this._clockToken;

    if (this._ready && !this._closed) {
      const playing = this._wantsPlayback &&
        this.context && this.context.state === 'running';
      this._request('seek', {
        sample: Math.floor(target * AUDIO_SAMPLE_RATE),
        playing,
      }).then((reply) => {
        if (playing) this._anchorClock(reply, target, token);
      }).catch((error) => this._backgroundError(error));
    }
    return target;
  }

  ensureRunning() {
    if (this._closed || !this._wantsPlayback) return Promise.resolve();
    if (this._fatalError) return Promise.reject(this._fatalError);
    if (!this._ready) return this.start(this._requestedTime).then(() => undefined);

    const resume = this.context.state === 'running'
      ? Promise.resolve()
      : this.context.resume();
    if (this._clockRunning) return Promise.resolve(resume);
    return Promise.resolve(resume)
      .then(() => {
        if (this._closed || !this._wantsPlayback) return;
        return this._playAt(this._requestedTime);
      })
      .then(() => undefined);
  }

  stop() {
    if (this._closed) return;
    this._closed = true;
    this._ready = false;
    this._wantsPlayback = false;
    this._clockRunning = false;
    this._activeTransportId = 0;
    ++this._clockToken;
    if (this._abortLoad) this._abortLoad.abort();

    if (this.node) {
      try { this.node.port.postMessage({ type: 'stop' }); } catch { /* closed port */ }
      this._disposeNode();
    }
    const error = stoppedError();
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this._pending.clear();

    if (this.context && this.context.state !== 'closed') {
      Promise.resolve(this.context.close()).catch(() => {});
    }
  }

  _ensureContext() {
    if (this.context) return this.context;
    const Context = audioContextConstructor();
    if (!Context) throw new Error('This browser does not support Web Audio.');

    try {
      this.context = new Context({ sampleRate: AUDIO_SAMPLE_RATE });
    } catch {
      // Some implementations only expose the hardware rate. The worklet has
      // a native-rate linear resampler for this fallback.
      this.context = new Context();
    }
    if (!this.context.audioWorklet) {
      this.context.close().catch(() => {});
      this.context = null;
      throw new Error('This browser does not support AudioWorklet playback.');
    }
    return this.context;
  }

  _disposeNode() {
    if (!this.node) return;
    try { this.node.disconnect(); } catch { /* disconnected already */ }
    this.node.port.onmessage = null;
    this.node.onprocessorerror = null;
    this.node = null;
  }

  _playAt(seconds) {
    const target = this._clamp(seconds);
    this._requestedTime = target;
    this._clockRunning = false;
    this._activeTransportId = 0;
    const token = ++this._clockToken;
    return this._request('play', {
      sample: Math.floor(target * AUDIO_SAMPLE_RATE),
    }).then((reply) => {
      this._anchorClock(reply, target, token);
    });
  }

  _anchorClock(reply, seconds, token) {
    if (this._closed || token !== this._clockToken || !this._wantsPlayback) return;
    const frame = Number(reply && reply.contextFrame);
    const sample = Number(reply && reply.sample);
    const anchoredTime = Number.isFinite(sample)
      ? sample / AUDIO_SAMPLE_RATE
      : seconds;
    this._clockTime = anchoredTime;
    this._clockContextTime = Number.isFinite(frame)
      ? frame / this.context.sampleRate
      : this.context.currentTime;
    this._requestedTime = anchoredTime;
    this._activeTransportId = Number(reply && reply.id) || 0;
    this._clockRunning = true;
  }

  _request(type, values = {}, transfer = []) {
    if (this._closed) return Promise.reject(stoppedError());
    if (!this.node) return Promise.reject(new Error('The Krawall audio worklet is not ready.'));
    const id = ++this._requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`The Krawall audio worklet did not answer the ${type} command.`));
      }, COMMAND_TIMEOUT_MS);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this.node.port.postMessage({ type, id, ...values }, transfer);
      } catch (error) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(error);
      }
    });
  }

  _handleMessage(message) {
    if (!message || this._closed) return;
    if (message.type === 'ended') {
      if (!this._activeTransportId ||
          message.transportId !== this._activeTransportId) return;
      this._requestedTime = this.duration;
      this._clockRunning = false;
      this._wantsPlayback = false;
      this._activeTransportId = 0;
      ++this._clockToken;
      if (this.onended) this.onended();
      return;
    }

    const pending = this._pending.get(message.id);
    if (message.type === 'error') {
      const error = new Error(message.message || 'The Krawall replay failed.');
      if (pending) {
        clearTimeout(pending.timer);
        this._pending.delete(message.id);
        pending.reject(error);
      } else {
        this._fail(error);
      }
      return;
    }
    if (!pending) return;
    clearTimeout(pending.timer);
    this._pending.delete(message.id);
    pending.resolve(message);
  }

  _fail(error) {
    if (this._closed || this._fatalError) return;
    this._fatalError = error;
    this._clockRunning = false;
    this._wantsPlayback = false;
    this._activeTransportId = 0;
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this._pending.clear();
    if (this.onerror) this.onerror(error);
    else console.error(error);
  }

  _backgroundError(error) {
    if (this._closed || (error && error.name === 'AbortError')) return;
    this._fail(error instanceof Error ? error : new Error(String(error)));
  }

  _clamp(seconds) {
    return Math.max(0, Math.min(
      Number.isFinite(seconds) ? seconds : 0,
      this.duration
    ));
  }

  get duration() { return AUDIO_DURATION_SECONDS; }

  get playing() {
    return this._wantsPlayback && this._ready && this._clockRunning &&
      this.context && this.context.state === 'running';
  }

  get paused() {
    return !this._wantsPlayback ||
      (!!this.context && this.context.state === 'suspended');
  }

  get loaded() { return this._ready; }
}
