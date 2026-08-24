// Real-time adapter for the pure Krawall replay engine. Krawall always runs
// at its native 32,768 Hz; a small linear resampler covers AudioContexts that
// only expose the hardware rate.
import { KrawallReplay } from './mcvirus_krawall.js';

const PROCESSOR_NAME = 'mcvirus-krawall';
const BUFFER_SAMPLES = 2048;

class MCVirusKrawallProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const config = options.processorOptions || {};
    this.nativeRate = Number(config.nativeRate) || 32768;
    this.durationSamples = Math.max(0, Number(config.durationSamples) | 0);
    this.ratio = this.nativeRate / sampleRate;

    this.replay = null;
    this.playing = false;
    this.stopped = false;
    this.endedSent = false;
    this.pendingStart = null;
    this.transportId = 0;
    this.nativeBuffer = null;
    this.nativeBufferIndex = 0;
    this.nextAbsoluteSample = 0;
    this.sourceIndex = 0;
    this.sourceFraction = 0;
    this.source0 = 0;
    this.source1 = 0;

    this.port.onmessage = (event) => this.handleCommand(event.data);
  }

  handleCommand(message) {
    if (!message || this.stopped) return;
    try {
      switch (message.type) {
        case 'init': {
          const module = new Uint8Array(message.module);
          const bank = new Uint8Array(message.bank);
          this.replay = new KrawallReplay(module, bank);
          if (!this.durationSamples) {
            this.durationSamples = this.replay.durationSamples;
          }
          this.resetResampler(0);
          this.reply('ready', message.id, {
            durationSamples: this.durationSamples,
            replaySamples: this.replay.durationSamples,
            outputRate: sampleRate,
          });
          break;
        }
        case 'play':
          this.requireReplay();
          this.resetResampler(message.sample);
          this.playing = true;
          this.transportId = message.id;
          this.deferStart('playing', message.id);
          break;
        case 'seek':
          this.requireReplay();
          this.resetResampler(message.sample);
          this.playing = !!message.playing;
          if (this.playing) {
            this.transportId = message.id;
            this.deferStart('seeked', message.id);
          } else {
            this.resolveSupersededStart();
            this.transportId = 0;
            this.reply('seeked', message.id, {
              contextFrame: currentFrame,
              sample: this.position,
            });
          }
          break;
        case 'stop':
          this.playing = false;
          this.transportId = 0;
          this.stopped = true;
          this.resolveSupersededStart();
          break;
      }
    } catch (error) {
      this.playing = false;
      this.resolveSupersededStart();
      this.transportId = 0;
      this.reply('error', message.id, {
        message: error && error.message ? error.message : String(error),
      });
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return !this.stopped;
    const left = output[0];
    const right = output[1] || left;
    left.fill(0);
    if (right !== left) right.fill(0);

    if (this.stopped) return false;
    if (!this.replay || !this.playing) return true;

    if (this.pendingStart) {
      const pending = this.pendingStart;
      this.pendingStart = null;
      this.reply(pending.type, pending.id, {
        contextFrame: currentFrame,
        sample: this.position,
      });
    }

    for (let index = 0; index < left.length; ++index) {
      if (this.position >= this.durationSamples) {
        this.playing = false;
        if (!this.endedSent) {
          this.endedSent = true;
          const transportId = this.transportId;
          this.transportId = 0;
          this.port.postMessage({
            type: 'ended',
            transportId,
            contextFrame: currentFrame + index,
            sample: this.durationSamples,
          });
        }
        break;
      }

      const value = this.source0 +
        (this.source1 - this.source0) * this.sourceFraction;
      left[index] = value;
      if (right !== left) right[index] = value;
      this.advanceSource();
    }
    return true;
  }

  resetResampler(value) {
    const position = Math.max(0, Math.min(
      Number.isFinite(value) ? Math.floor(value) : 0,
      this.durationSamples
    ));
    // KrawallReplay owns the complete demo timeline, including the cartridge
    // startup silence and Direct Sound output delay.
    this.replay.seek(Math.min(position, this.replay.durationSamples));
    this.nativeBuffer = null;
    this.nativeBufferIndex = 0;
    this.nextAbsoluteSample = position;
    this.sourceIndex = position;
    this.sourceFraction = 0;
    this.source0 = this.takeNativeSample();
    this.source1 = this.takeNativeSample();
    this.endedSent = false;
  }

  advanceSource() {
    this.sourceFraction += this.ratio;
    while (this.sourceFraction >= 1) {
      this.sourceFraction -= 1;
      ++this.sourceIndex;
      this.source0 = this.source1;
      this.source1 = this.takeNativeSample();
    }
  }

  takeNativeSample() {
    const absolute = this.nextAbsoluteSample++;
    if (absolute >= this.durationSamples || absolute >= this.replay.durationSamples) {
      return 0;
    }
    if (this.nativeBuffer && this.nativeBufferIndex < this.nativeBuffer.length) {
      const buffered = this.nativeBuffer[this.nativeBufferIndex++];
      return Number.isFinite(buffered) ? buffered : 0;
    }
    if (this.replay.ended) return 0;
    {
      const count = Math.min(BUFFER_SAMPLES, this.replay.durationSamples - absolute);
      this.nativeBuffer = this.replay.render(count);
      this.nativeBufferIndex = 0;
      if (!(this.nativeBuffer instanceof Float32Array)) {
        throw new Error('KrawallReplay.render() must return a Float32Array.');
      }
    }
    const value = this.nativeBuffer[this.nativeBufferIndex++];
    return Number.isFinite(value) ? value : 0;
  }

  deferStart(type, id) {
    this.resolveSupersededStart();
    this.pendingStart = { type, id };
  }

  resolveSupersededStart() {
    if (!this.pendingStart) return;
    const pending = this.pendingStart;
    this.pendingStart = null;
    this.reply(pending.type, pending.id, {
      contextFrame: currentFrame,
      sample: this.position,
      superseded: true,
    });
  }

  requireReplay() {
    if (!this.replay) throw new Error('The Krawall replay has not been initialized.');
  }

  reply(type, id, values = {}) {
    this.port.postMessage({ type, id, ...values });
  }

  get position() {
    return this.sourceIndex + this.sourceFraction;
  }
}

registerProcessor(PROCESSOR_NAME, MCVirusKrawallProcessor);
