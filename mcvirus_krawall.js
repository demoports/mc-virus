/*
 * Krawall, XM/S3M Modplayer Library
 * Copyright (C) 2001-2005, 2013 Sebastian Kienzl
 *
 * JavaScript adaptation of the replay path used by Virus. This file is free
 * software under the GNU Lesser General Public License, version 2.1 or (at
 * your option) any later version. See COPYING.Krawall for the full terms.
 *
 * This file is distributed without any warranty; without even the implied
 * warranty of merchantability or fitness for a particular purpose.
 */

// A focused JavaScript port of the Krawall 2005 replay path used by Virus.
//
// The cartridge contains Krawall's converted KRWM module and KRWB sample bank,
// not the source XM.  This player deliberately implements the small subset the
// song uses: XM volume slides, tone portamento, sample offsets, Zxx markers,
// instrument volume envelopes, and Krawall's normal-quality mono mixer.

import {
  AUDIO_DURATION_SECONDS,
  AUDIO_SAMPLE_RATE,
  KRAP_PLAY_SAMPLE,
} from './mcvirus_constants.js';

const KRWM_HEADER_SIZE = 364;
const INSTRUMENT_SIZE = 302;
const TICK_SAMPLES = 468;
const WORKER_SAMPLES = 552;
const MIX_QUANTUM = 4;

// The GBA mixer renders into a four-block Direct Sound ring.  Its callbacks
// therefore lead the sound heard at the DAC.  Keeping that lead preserves the
// same relationship between the Zxx-driven pictures and the music.
export const KRAWALL_OUTPUT_DELAY_SAMPLES = 2095;
export const KRAWALL_START_SAMPLE = KRAP_PLAY_SAMPLE + KRAWALL_OUTPUT_DELAY_SAMPLES;
export const KRAWALL_DURATION_SAMPLES = Math.round(
  AUDIO_DURATION_SECONDS * AUDIO_SAMPLE_RATE
);

const SNAPSHOT_INTERVAL = AUDIO_SAMPLE_RATE * 4;
const OUTPUT_SCALE = 0.75 / 128;

const EFFECT_VOLSLIDE_XM = 7;
const EFFECT_PORTA_NOTE = 19;
const EFFECT_OFFSET = 27;
const EFFECT_MARK = 36;

const ENV_ENABLED = 1;
const ENV_SUSTAIN = 2;
const ENV_LOOP = 4;
const ENV_DISABLED = 0;
const ENV_STOPPED = 1;
const ENV_SUSTAINING = 2;
const ENV_ACTIVE = 3;
const ENV_ACTIVE_NO_SUSTAIN = 4;

function byteString(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function signed8(value) {
  return value < 128 ? value : value - 256;
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function uint16(value) {
  return value & 0xffff;
}

function readEnvelope(view, offset) {
  const nodes = [];
  for (let index = 0; index < 12; ++index) {
    nodes.push({
      coord: view.getUint16(offset + index * 4, true),
      inc: view.getUint16(offset + index * 4 + 2, true),
    });
  }
  return {
    nodes,
    max: view.getUint8(offset + 48),
    sustain: view.getUint8(offset + 49),
    loopStart: view.getUint8(offset + 50),
    flags: view.getUint8(offset + 51),
  };
}

function parseBank(source) {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  if (byteString(bytes, 0, 4) !== 'KRWB') {
    throw new Error('The Krawall sample bank has an invalid KRWB header.');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const instrumentCount = view.getUint16(4, true);
  const sampleCount = view.getUint16(6, true);
  const instruments = [];
  const samples = [];

  for (let index = 0; index < instrumentCount; ++index) {
    const offset = view.getUint32(8 + index * 4, true);
    if (offset + INSTRUMENT_SIZE > bytes.length) {
      throw new Error(`Krawall instrument ${index} lies outside the bank.`);
    }
    const sampleMap = new Uint16Array(96);
    for (let note = 0; note < sampleMap.length; ++note) {
      sampleMap[note] = view.getUint16(offset + note * 2, true);
    }
    instruments.push({
      index,
      sampleMap,
      envVolume: readEnvelope(view, offset + 192),
      envPanning: readEnvelope(view, offset + 244),
      volumeFade: view.getUint16(offset + 296, true),
      vibratoType: view.getUint8(offset + 298),
      vibratoSweep: view.getUint8(offset + 299),
      vibratoDepth: view.getUint8(offset + 300),
      vibratoRate: view.getUint8(offset + 301),
    });
  }

  const sampleTable = 8 + instrumentCount * 4;
  for (let index = 0; index < sampleCount; ++index) {
    const offset = view.getUint32(sampleTable + index * 4, true);
    if (offset + 18 > bytes.length) {
      throw new Error(`Krawall sample ${index} lies outside the bank.`);
    }
    const dataOffset = offset + 18;
    const endOffset = view.getUint32(offset + 4, true);
    if (endOffset < dataOffset || endOffset > bytes.length) {
      throw new Error(`Krawall sample ${index} has an invalid end pointer.`);
    }
    samples.push({
      index,
      bytes,
      dataOffset,
      length: endOffset - dataOffset,
      loopLength: view.getUint32(offset, true),
      c2Frequency: view.getUint32(offset + 8, true),
      fineTune: view.getInt8(offset + 12),
      relativeNote: view.getInt8(offset + 13),
      defaultVolume: view.getUint8(offset + 14),
      defaultPanning: view.getInt8(offset + 15),
      loop: view.getUint8(offset + 16),
      highQuality: view.getUint8(offset + 17),
    });
  }

  return { bytes, instruments, samples };
}

function parseModule(source) {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  if (byteString(bytes, 0, 4) !== 'KRWM') {
    throw new Error('The Krawall module has an invalid KRWM header.');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const base = 4;
  const channels = view.getUint8(base);
  const orderCount = view.getUint8(base + 1);
  const orders = Array.from(bytes.subarray(base + 3, base + 3 + orderCount));
  const patternCount = Math.max(...orders.filter((value) => value < 254)) + 1;
  const patterns = [];
  const pointerTable = base + KRWM_HEADER_SIZE;

  for (let index = 0; index < patternCount; ++index) {
    const offset = view.getUint32(pointerTable + index * 4, true);
    if (offset + 34 > bytes.length) {
      throw new Error(`Krawall pattern ${index} lies outside the module.`);
    }
    patterns.push({
      offset,
      rows: view.getUint16(offset + 32, true),
      dataOffset: offset + 34,
    });
  }

  return {
    bytes,
    channels,
    orderCount,
    restart: view.getUint8(base + 2),
    orders,
    channelPanning: Array.from(
      bytes.subarray(base + 259, base + 259 + 32), signed8
    ),
    songIndex: Array.from(bytes.subarray(base + 291, base + 291 + 64)),
    globalVolume: view.getUint8(base + 355),
    initialSpeed: view.getUint8(base + 356),
    initialBpm: view.getUint8(base + 357),
    instrumentBased: !!view.getUint8(base + 358),
    linearSlides: !!view.getUint8(base + 359),
    fastVolumeSlides: !!view.getUint8(base + 360),
    patterns,
  };
}

// The original table was generated by Krawall's converter.  A one-unit
// difference in its 31-bit entries disappears in the subsequent integer
// division for every period this module can address.
const LINEAR_FREQUENCIES = Array.from({ length: 768 }, (_, remainder) =>
  Math.round(8363 * 2 ** ((17 * 768 + remainder) / (12 * 64)))
);

function linearPeriod(note, sample) {
  return (note << 6) + 2 * 768 + (sample.fineTune >> 1);
}

function linearFrequency(period) {
  const octave = Math.floor(period / 768);
  const remainder = period - octave * 768;
  return Math.floor(LINEAR_FREQUENCIES[remainder] / 2 ** (23 - octave));
}

function makeChannel(panning) {
  return {
    volume: 0,
    channelVolume: 64,
    panning,
    volumeCurrent: 0,
    sample: null,
    instrument: null,
    note: 0,
    period: 0,
    portamentoDestination: 0,
    portamentoIncrement: 0,
    volumeSlide: 0,
    effect: 0,
    effectOperand: 0,
    sampleOffset: 0,
    mix: null,

    instrumentActive: false,
    envelopeVolumeStatus: ENV_DISABLED,
    envelopeVolume: 64,
    envelopeVolumePosition: 0,
    envelopeVolumeNode: -1,
    envelopeVolumeTick: -1,
    envelopeVolumeTickTarget: 0,
    envelopeFadeActive: false,
    envelopeFade: 32767,
  };
}

function cloneChannel(channel) {
  return {
    ...channel,
    mix: channel.mix ? { ...channel.mix } : null,
  };
}

export class KrawallReplay {
  constructor(moduleBytes, bankBytes, options = {}) {
    this.module = parseModule(moduleBytes);
    this.bank = parseBank(bankBytes);
    this.onMarker = options.onMarker || null;
    this.durationSamples = KRAWALL_DURATION_SAMPLES;
    this._snapshots = [];
    this._quantum = new Int8Array(MIX_QUANTUM);
    this._accumulators = new Int32Array(MIX_QUANTUM);
    this.reset();
  }

  reset() {
    this.position = 0;
    this._started = false;
    this._songPlaying = false;
    this._order = 0;
    this._row = 0;
    this._pattern = null;
    this._patternData = 0;
    this._tick = this.module.initialSpeed;
    this._speed = this.module.initialSpeed;
    this._timerSamples = TICK_SAMPLES;
    this._workerSamples = WORKER_SAMPLES;
    this._segmentSamples = 0;
    this._quantumIndex = MIX_QUANTUM;
    this._nextSnapshotSample = SNAPSHOT_INTERVAL;
    this._channels = Array.from(
      { length: this.module.channels },
      (_, index) => makeChannel(this.module.channelPanning[index] || 0)
    );
    this._snapshots.length = 0;
    this._storeSnapshot();
  }

  get ended() {
    return this.position >= this.durationSamples;
  }

  seek(sample) {
    const target = clamp(Math.floor(Number(sample) || 0), 0, this.durationSamples);
    if (target === this.position) return target;

    if (target < this.position) {
      let snapshot = this._snapshots[0];
      for (const candidate of this._snapshots) {
        if (candidate.position > target) break;
        snapshot = candidate;
      }
      this._restoreSnapshot(snapshot);
    }

    while (this.position < target) this._nextSample();
    return this.position;
  }

  render(count) {
    count = Math.max(0, Math.floor(Number(count) || 0));
    const output = new Float32Array(count);
    for (let index = 0; index < count; ++index) {
      output[index] = this._nextSample() * OUTPUT_SCALE;
    }
    return output;
  }

  _nextSample() {
    if (this.position >= this.durationSamples) return 0;

    if (!this._started && this.position >= KRAWALL_START_SAMPLE) {
      this._startSong();
    }

    let value = 0;
    if (this._started) {
      if (this._quantumIndex >= MIX_QUANTUM) {
        this._mixQuantum();
        this._quantumIndex = 0;
      }
      value = this._quantum[this._quantumIndex++];
    }

    ++this.position;
    if (this._quantumIndex >= MIX_QUANTUM &&
        this.position >= this._nextSnapshotSample) {
      while (this._nextSnapshotSample <= this.position) {
        this._nextSnapshotSample += SNAPSHOT_INTERVAL;
      }
      this._storeSnapshot();
    }
    return value;
  }

  _startSong() {
    this._started = true;
    this._songPlaying = true;
    this._tick = this._speed = this.module.initialSpeed;
    this._timerSamples = TICK_SAMPLES;
    this._workerSamples = WORKER_SAMPLES;
    this._segmentSamples = 0;
    this._order = this.module.songIndex[0] || 0;
    this._row = 0;
    this._setPattern();
  }

  _setPattern() {
    this._pattern = this.module.patterns[this.module.orders[this._order]];
    this._patternData = this._pattern.dataOffset;
  }

  _mixQuantum() {
    this._quantum.fill(0);

    if (this._songPlaying) {
      if (!this._segmentSamples) this._beginMixSegment();
      const accumulators = this._accumulators;
      accumulators.fill(0);
      for (const channel of this._channels) {
        const mix = channel.mix;
        if (!mix || !mix.active) continue;
        if (mix.silentSegment) continue;
        // This ROM predates the current public Krawall mono setup.  Its mono
        // path pins panning left, which makes lvol exactly twice the logical
        // tracker volume (the right FIFO is disabled).
        const volume = mix.volume * 2;

        for (let index = 0; index < MIX_QUANTUM; ++index) {
          const byte = mix.sample.bytes[mix.sample.dataOffset + mix.position];
          // Reading a few guard bytes past the logical end is intentional: the
          // ARM mixer rounds each boundary segment up to four output samples.
          accumulators[index] += (((byte === undefined ? 128 : byte) * volume) >> 3) -
            volume * 16;
          this._advanceMixPosition(mix);
        }
        this._finishMixQuantum(mix);
      }

      for (let index = 0; index < MIX_QUANTUM; ++index) {
        this._quantum[index] = clamp(accumulators[index] >> 5, -128, 127);
      }
    }

    this._timerSamples -= MIX_QUANTUM;
    this._workerSamples -= MIX_QUANTUM;
    this._segmentSamples -= MIX_QUANTUM;
    if (this._timerSamples === 0 && this._songPlaying) {
      this._processTick();
      this._timerSamples = TICK_SAMPLES;
    }
    if (this._workerSamples === 0) this._workerSamples = WORKER_SAMPLES;
  }

  _beginMixSegment() {
    // The ARM mixer is called once for each uninterrupted portion of its
    // 552-sample DMA worker buffer. Tracker ticks split those calls every 468
    // samples. Its zero-volume fast path advances a voice once for that whole
    // call, so reproducing the same call boundaries matters when an envelope
    // later makes a silent looping voice audible again.
    this._segmentSamples = Math.min(this._timerSamples, this._workerSamples);
    for (const channel of this._channels) {
      const mix = channel.mix;
      if (!mix || !mix.active) continue;
      mix.silentSegment = !mix.volume;
      if (mix.silentSegment) this._advanceSilentMix(mix, this._segmentSamples);
    }
  }

  _advanceMixPosition(mix) {
    const phase = mix.fraction + mix.increment;
    const whole = Math.floor(phase / 65536);
    mix.fraction = phase - whole * 65536;
    mix.position += whole;
  }

  _advanceSilentMix(mix, amount) {
    // Krawall's zero-volume fast path intentionally uses a conservative
    // whole-byte estimate and leaves the Q16 fraction untouched.  A later
    // envelope fade-in makes this optimization audible in Virus.
    const step = Math.floor(mix.increment / 65536) + 1;
    const sampleAdvance = amount * step;
    const loopStart = mix.sample.length - mix.sample.loopLength;

    if (!mix.sample.loop) {
      if (mix.position + sampleAdvance >= mix.sample.length) mix.active = false;
      else mix.position += sampleAdvance;
      return;
    }

    if (mix.sample.loop === 1) {
      mix.position += sampleAdvance;
      while (mix.position >= mix.sample.length) {
        mix.position -= mix.sample.loopLength;
      }
      return;
    }

    mix.position += sampleAdvance;
    let crossings = 0;
    if (mix.increment >= 0) {
      while (mix.position >= mix.sample.length) {
        mix.position -= mix.sample.loopLength;
        ++crossings;
      }
      if (crossings & 1) {
        mix.position = mix.sample.length - (mix.position - loopStart);
        mix.increment = -mix.increment;
      }
    } else {
      while (mix.position < loopStart) {
        mix.position += mix.sample.loopLength;
        ++crossings;
      }
      if (crossings & 1) {
        mix.position = loopStart + (mix.sample.length - mix.position);
        mix.increment = -mix.increment;
      }
    }
  }

  _finishMixQuantum(mix) {
    if (mix.increment >= 0 && mix.position >= mix.sample.length) {
      if (mix.sample.loop === 2) {
        mix.increment = -mix.increment;
      } else if (mix.sample.loop === 1 && mix.sample.loopLength) {
        mix.position -= mix.sample.loopLength;
      } else {
        mix.active = false;
      }
    } else if (
      mix.increment < 0 &&
      (mix.position < mix.sample.length - mix.sample.loopLength ||
        (mix.position === mix.sample.length - mix.sample.loopLength &&
          mix.fraction === 0))
    ) {
      if (mix.sample.loop === 2) mix.increment = -mix.increment;
      else mix.active = false;
    }
  }

  _processTick() {
    if (++this._tick >= this._speed) {
      this._tick = 0;
      this._processRow();
    } else {
      this._processBetweenRows();
    }
    this._processInstruments();
  }

  _processRow() {
    const bytes = this.module.bytes;
    for (const channel of this._channels) channel.touched = false;
    while (true) {
      const follow = bytes[this._patternData++];
      if (!follow) break;

      const channel = this._channels[follow & 0x1f];
      channel.touched = true;
      let note = 0;
      let instrumentNumber = 0;
      let volume = 0;
      let effect = 0;
      let operand = 0;

      if (follow & 0x20) {
        note = bytes[this._patternData++];
        instrumentNumber = bytes[this._patternData++];
        if (note & 0x80) {
          instrumentNumber |= bytes[this._patternData++] << 8;
          note &= 0x7f;
        }
      }
      if (follow & 0x40) volume = bytes[this._patternData++];
      if (follow & 0x80) {
        effect = bytes[this._patternData++];
        operand = bytes[this._patternData++];
      }

      channel.effect = effect;
      channel.effectOperand = operand;
      let setVolume = false;
      let sampleSet = false;

      if (instrumentNumber) {
        const instrument = this.bank.instruments[instrumentNumber - 1];
        if (note && instrument) {
          channel.instrument = instrument;
          channel.sample = this.bank.samples[instrument.sampleMap[note - 1]];
          if (!channel.sample) {
            throw new Error(`Krawall instrument ${instrumentNumber} selects a missing sample.`);
          }
          channel.volume = channel.volumeCurrent = channel.sample.defaultVolume;
          channel.panning = channel.sample.defaultPanning;
          setVolume = true;
          sampleSet = true;
        }
      }

      if (volume) {
        // Virus only contains direct $10-$50 volume-column values.
        channel.volume = channel.volumeCurrent = clamp(volume - 0x10, 0, 0x40);
        setVolume = true;
      }

      let playNote = false;
      if (note && channel.sample) {
        if (note === 0x7f) {
          this._releaseInstrument(channel);
        } else {
          --note;
          note += channel.sample.relativeNote;
          if (effect !== EFFECT_PORTA_NOTE) {
            if (!sampleSet && channel.instrument) {
              channel.sample = this.bank.samples[channel.instrument.sampleMap[note]];
            }
            channel.note = note;
            channel.period = channel.portamentoDestination = linearPeriod(
              note,
              channel.sample
            );
            channel.sampleOffset = 0;
            playNote = true;
          } else {
            channel.portamentoDestination = linearPeriod(note, channel.sample);
          }
        }
      }

      this._effectOnRow(channel, effect, operand, playNote);
      if (playNote) this._playChannel(channel);
      else if (setVolume) this._setChannelVolume(channel);
    }

    for (const channel of this._channels) {
      if (!channel.touched) {
        channel.effect = 0;
        channel.effectOperand = 0;
      }
    }

    if (++this._row >= this._pattern.rows) {
      ++this._order;
      if (this._order >= this.module.orderCount) {
        this._stopSong();
        return;
      }
      this._row = 0;
      this._setPattern();
    }
  }

  _effectOnRow(channel, effect, operand, playNote) {
    switch (effect) {
      case EFFECT_VOLSLIDE_XM:
        if (operand) channel.volumeSlide = operand;
        break;
      case EFFECT_PORTA_NOTE:
        if (operand) channel.portamentoIncrement = operand;
        break;
      case EFFECT_OFFSET:
        if (operand) {
          if (playNote) {
            channel.sampleOffset = operand;
          } else if (channel.mix && channel.mix.active) {
            channel.mix.position = operand << 8;
            channel.mix.fraction = 0;
          }
        }
        break;
      case EFFECT_MARK:
        if (this.onMarker) {
          // Row processing happens after this four-sample quantum has been
          // generated. Report the original CPU callback time, which leads the
          // delayed Direct Sound output consumed by render().
          const callbackSample = this.position + MIX_QUANTUM -
            KRAWALL_OUTPUT_DELAY_SAMPLES;
          this.onMarker(operand, callbackSample);
        }
        break;
    }
  }

  _processBetweenRows() {
    for (const channel of this._channels) {
      if (channel.effect === EFFECT_VOLSLIDE_XM) {
        const down = channel.volumeSlide & 0x0f;
        const up = channel.volumeSlide >> 4;
        channel.volume = clamp(channel.volume + (down ? -down : up), 0, 64);
        this._setChannelVolume(channel);
      } else if (channel.effect === EFFECT_PORTA_NOTE) {
        const amount = channel.portamentoIncrement << 2;
        if (channel.period > channel.portamentoDestination) {
          channel.period = Math.max(
            channel.portamentoDestination,
            channel.period - amount
          );
        } else if (channel.period < channel.portamentoDestination) {
          channel.period = Math.min(
            channel.portamentoDestination,
            channel.period + amount
          );
        }
        this._setChannelFrequency(channel);
      }
    }
  }

  _initInstrument(channel) {
    const instrument = channel.instrument;
    channel.instrumentActive = false;
    channel.envelopeFadeActive = false;
    channel.envelopeFade = 32767;

    if (instrument.envVolume.flags & ENV_ENABLED) {
      channel.envelopeVolumeStatus = ENV_ACTIVE;
      channel.envelopeVolumeNode = -1;
      channel.envelopeVolumeTick = -1;
      channel.envelopeVolumeTickTarget = 0;
      channel.instrumentActive = true;
    } else {
      channel.envelopeVolumeStatus = ENV_DISABLED;
      channel.envelopeVolume = 64;
    }

    if (instrument.envPanning.flags & ENV_ENABLED || instrument.vibratoRate) {
      channel.instrumentActive = true;
    }
  }

  _releaseInstrument(channel) {
    if (channel.envelopeVolumeStatus) {
      channel.envelopeFadeActive = true;
      channel.envelopeVolumeStatus =
        channel.envelopeVolumeStatus === ENV_SUSTAINING
          ? ENV_ACTIVE
          : ENV_ACTIVE_NO_SUSTAIN;
    } else {
      this._stopChannel(channel);
    }
  }

  _processInstruments() {
    for (const channel of this._channels) {
      if (!channel.instrumentActive || !channel.instrument) continue;
      const instrument = channel.instrument;
      const envelope = instrument.envVolume;
      let setVolume = false;

      if (channel.envelopeVolumeStatus) {
        if (channel.envelopeFadeActive) {
          setVolume = true;
          channel.envelopeFade -= instrument.volumeFade;
          if (channel.envelopeFade <= 0) {
            this._stopChannel(channel);
            continue;
          }
        }

        if (channel.envelopeVolumeStatus >= ENV_ACTIVE) {
          setVolume = true;
          if (channel.envelopeVolumeNode >= 0) {
            const node = envelope.nodes[channel.envelopeVolumeNode];
            channel.envelopeVolumePosition = uint16(
              channel.envelopeVolumePosition + node.inc
            );
          }

          channel.envelopeVolumeTick = uint16(channel.envelopeVolumeTick + 1) & 0xff;
          if (channel.envelopeVolumeTick === channel.envelopeVolumeTickTarget) {
            ++channel.envelopeVolumeNode;

            if (
              envelope.flags & ENV_SUSTAIN &&
              channel.envelopeVolumeNode === envelope.sustain &&
              channel.envelopeVolumeStatus !== ENV_ACTIVE_NO_SUSTAIN
            ) {
              channel.envelopeVolumeStatus = ENV_SUSTAINING;
            }

            if (channel.envelopeVolumeNode === envelope.max) {
              if (envelope.flags & ENV_LOOP) {
                channel.envelopeVolumeNode = envelope.loopStart;
                channel.envelopeVolumeTick =
                  envelope.nodes[channel.envelopeVolumeNode].coord & 0xff;
              } else {
                channel.envelopeVolumeStatus = ENV_STOPPED;
                if ((envelope.nodes[channel.envelopeVolumeNode].coord >> 9) === 0) {
                  this._stopChannel(channel);
                  continue;
                }
              }
            }

            const node = envelope.nodes[channel.envelopeVolumeNode];
            const next = envelope.nodes[channel.envelopeVolumeNode + 1] || node;
            channel.envelopeVolumePosition = (node.coord >> 9) << 8;
            // Krawall stores both fields as u8 even though the packed coord
            // reserves nine bits for the tick.  The truncation is observable
            // in the long release envelopes in this song.
            channel.envelopeVolumeTickTarget = (1 + (next.coord & 0x1ff)) & 0xff;
          }
        }

        if (setVolume) {
          channel.envelopeVolume = signed8(
            (channel.envelopeVolumePosition * channel.envelopeFade) >> 23 & 0xff
          );
          this._setChannelVolume(channel);
        }
      }
    }
  }

  _playChannel(channel) {
    this._initInstrument(channel);
    const frequency = linearFrequency(channel.period);
    const position = channel.sampleOffset << 8;
    channel.mix = {
      active: position < channel.sample.length,
      sample: channel.sample,
      position,
      fraction: 0,
      increment: Math.floor(frequency / 2) * 4,
      volume: (channel.volume * channel.channelVolume) >> 6,
      silentSegment: false,
    };
  }

  _setChannelFrequency(channel) {
    if (!channel.mix || !channel.mix.active) return false;
    const frequency = linearFrequency(channel.period);
    const increment = Math.floor(frequency / 2) * 4;
    channel.mix.increment = channel.mix.increment < 0 ? -increment : increment;
    return true;
  }

  _setChannelVolume(channel) {
    channel.volumeCurrent = channel.volume;
    if (!channel.mix || !channel.mix.active) return false;
    channel.mix.volume =
      (channel.volumeCurrent * channel.channelVolume * channel.envelopeVolume) >> 12;
    return true;
  }

  _stopChannel(channel) {
    channel.instrumentActive = false;
    if (channel.mix) channel.mix.active = false;
  }

  _stopSong() {
    this._songPlaying = false;
    for (const channel of this._channels) this._stopChannel(channel);
  }

  _storeSnapshot() {
    if (this._snapshots.some((snapshot) => snapshot.position === this.position)) return;
    this._snapshots.push({
      position: this.position,
      started: this._started,
      songPlaying: this._songPlaying,
      order: this._order,
      row: this._row,
      pattern: this._pattern,
      patternData: this._patternData,
      tick: this._tick,
      speed: this._speed,
      timerSamples: this._timerSamples,
      workerSamples: this._workerSamples,
      segmentSamples: this._segmentSamples,
      nextSnapshotSample: this._nextSnapshotSample,
      quantum: new Int8Array(this._quantum),
      quantumIndex: this._quantumIndex,
      channels: this._channels.map(cloneChannel),
    });
  }

  _restoreSnapshot(snapshot) {
    this.position = snapshot.position;
    this._started = snapshot.started;
    this._songPlaying = snapshot.songPlaying;
    this._order = snapshot.order;
    this._row = snapshot.row;
    this._pattern = snapshot.pattern;
    this._patternData = snapshot.patternData;
    this._tick = snapshot.tick;
    this._speed = snapshot.speed;
    this._timerSamples = snapshot.timerSamples;
    this._workerSamples = snapshot.workerSamples;
    this._segmentSamples = snapshot.segmentSamples;
    this._nextSnapshotSample = snapshot.nextSnapshotSample;
    this._quantum.set(snapshot.quantum);
    this._quantumIndex = snapshot.quantumIndex;
    this._channels = snapshot.channels.map(cloneChannel);
  }
}

export const internals = Object.freeze({
  parseBank,
  parseModule,
  linearPeriod,
  linearFrequency,
});
