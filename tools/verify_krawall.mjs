#!/usr/bin/env node

// Deterministic smoke test for the extracted song and focused Krawall replay.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  KRAWALL_DURATION_SAMPLES,
  KRAWALL_START_SAMPLE,
  KrawallReplay,
  internals,
} from '../mcvirus_krawall.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_PATH = resolve(ROOT, 'Module0.krw');
const BANK_PATH = resolve(ROOT, 'mc-virus.gba.krb');
const EXPECTED_MODULE_HASH =
  '629b965d5f754e43366c43ac4eb31c1b4d968036380f6b5935f6c975c761b5c9';
const EXPECTED_BANK_HASH =
  'c8fae5159b443bec48cf14ce6af321c05c39257a3b68cd4b12a349966e108af2';
const EXPECTED_REPLAY_HASH =
  '8085b23d829f1452ebc1df32392509b9654eb8f6681bbfb6e3d38adf9032b3f2';
const OUTPUT_TO_SIGNED_BYTE = 128 / 0.75;
const SEEK_SAMPLE = 5_500_123;
const SEEK_LENGTH = 4096;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function asSignedBytes(samples) {
  const output = new Int8Array(samples.length);
  for (let index = 0; index < samples.length; ++index) {
    output[index] = Math.round(samples[index] * OUTPUT_TO_SIGNED_BYTE);
  }
  return output;
}

const moduleBytes = readFileSync(MODULE_PATH);
const bankBytes = readFileSync(BANK_PATH);
assert.equal(sha256(moduleBytes), EXPECTED_MODULE_HASH, 'module hash');
assert.equal(sha256(bankBytes), EXPECTED_BANK_HASH, 'bank hash');

const module = internals.parseModule(moduleBytes);
const bank = internals.parseBank(bankBytes);
assert.equal(module.channels, 12, 'channel count');
assert.equal(module.orderCount, 34, 'order count');
assert.equal(module.patterns.length, 34, 'pattern count');
assert.equal(bank.instruments.length, 32, 'instrument count');
assert.equal(bank.samples.length, 32, 'sample count');
assert.equal(KRAWALL_START_SAMPLE, 145_915, 'soundtrack start');
assert.equal(KRAWALL_DURATION_SAMPLES, 6_258_901, 'soundtrack duration');

const markers = [];
const replay = new KrawallReplay(moduleBytes, bankBytes, {
  onMarker: (value, sample) => markers.push([sample, value]),
});
const replayHash = createHash('sha256');
const seekExpected = new Int8Array(SEEK_LENGTH);
let firstNonzero = -1;
let lastNonzero = -1;

for (let base = 0; base < replay.durationSamples; base += 32768) {
  const count = Math.min(32768, replay.durationSamples - base);
  const signed = asSignedBytes(replay.render(count));
  replayHash.update(new Uint8Array(signed.buffer, signed.byteOffset, signed.byteLength));

  for (let index = 0; index < signed.length; ++index) {
    const absolute = base + index;
    if (signed[index]) {
      if (firstNonzero < 0) firstNonzero = absolute;
      lastNonzero = absolute;
    }
    if (absolute >= SEEK_SAMPLE && absolute < SEEK_SAMPLE + SEEK_LENGTH) {
      seekExpected[absolute - SEEK_SAMPLE] = signed[index];
    }
  }
}

assert.equal(replayHash.digest('hex'), EXPECTED_REPLAY_HASH, 'replay hash');
assert.equal(firstNonzero, 146_383, 'first audible sample');
assert.equal(lastNonzero, 6_253_774, 'last audible sample');
assert.equal(markers.length, 169, 'marker count');
assert.deepEqual(markers[0], [144_288, 0x20], 'first marker');
assert.deepEqual(markers.at(-1), [5_895_072, 0xfb], 'last marker');
assert.ok(replay._snapshots.length >= 48, 'periodic seek snapshots');
const markerCount = markers.length;

replay.onMarker = null;
replay.seek(SEEK_SAMPLE);
const seekActual = asSignedBytes(replay.render(SEEK_LENGTH));
assert.deepEqual(seekActual, seekExpected, 'snapshot seek');

console.log('Krawall replay verified:');
console.log(`  ${module.channels} channels, ${module.patterns.length} patterns`);
console.log(`  ${bank.instruments.length} instruments, ${bank.samples.length} samples`);
console.log(`  ${markerCount} sync markers, ${replay.durationSamples} output samples`);
console.log(`  replay SHA-256 ${EXPECTED_REPLAY_HASH}`);
