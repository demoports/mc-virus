# Virus (canvas2d port)

This is a JavaScript, Canvas 2D and Web Audio reconstruction of **Virus**, the
Game Boy Advance demo by Matt Current. The original placed first in the console
competition at [The Ultimate Meeting 2004](https://www.pouet.net/prod.php?which=15121).
The published credits are annieeee (code and graphics), dodke (graphics), and
rjv (music).

The port was built from the released `mc-virus.gba`: its ARM code was
disassembled, its private asset archive and Krawall song data were decoded, and
native mGBA output was captured as a reference. It is a browser
reimplementation, not an emulator. No executable ARM code is run or embedded in
the page.

## Files

| file | purpose |
|---|---|
| `index.html` | fixed 240x160 canvas, static launcher styling, and ES-module entry point |
| `launcher.png` | native-resolution still used as the responsive launcher backdrop |
| `mcvirus_app.js` | launcher UI, keyboard controls, and compatibility globals |
| `mcvirus.js` | public module API, audio-clocked frame loop, and validation entry point |
| `mcvirus_constants.js` | shared display, timing, and sample-rate constants |
| `mcvirus_audio.js` | AudioContext/worklet loading, controls, seeking, and playback clock |
| `mcvirus_krawall.js` | pure JavaScript Krawall sequencer, envelopes, and native-rate mixer |
| `mcvirus_krawall_worklet.js` | real-time AudioWorklet adapter and output-rate conversion |
| `mcvirus_fx.js` | part sequencer and per-part visual reconstruction |
| `mcvirus_engine.js` | indexed-color software 3D renderer and tunnel primitive |
| `mcvirus_core.js` | ROM-asset parsers, framebuffer/palette helpers, and sync-state replay |
| `mcvirus_data.js` | generated gzip/base64 archive data and the 169 decoded sync markers |
| `Module0.krw` | exact converted Krawall module used by the browser player |
| `mc-virus.gba.krb` | exact instruments, samples, loops, envelopes, and native mixer guards |
| `COPYING.Krawall` | LGPL-2.1 license covering the adapted Krawall replay code |
| `notes/ASSET_MANIFEST.tsv` | generated inventory of all 147 archive entries |
| `notes/SYNC_TIMELINE.tsv` | generated Krawall timing and every `Zxx` marker |
| `notes/DISASSEMBLY.md` | addresses, recovered formats, engine contracts, and methodology |
| `tools/analyze_rom.py` | reproducibly regenerates the two text reports from the ROM |
| `tools/build_data.py` | rebuilds the visual data module and Krawall runtime assets |
| `tools/extract_krawall.py` | losslessly extracts and validates the KRWM/KRWB runtime inputs |
| `tools/verify_krawall.mjs` | deterministic asset, full-replay, marker, and seek regression test |
| `tools/mgba_reference.c` | native headless mGBA frame/audio/state recorder |
| `tools/mgba_trace.py` | GDB-stub diagnostic tracer and partial Mode-4/OBJ compositor |
| `tools/DecompileFunctions.java` | helper for decompiling explicitly seeded Ghidra functions |

## Port design

The original uses GBA Mode 4: two page-flipped 240x160 byte framebuffers, a
256-entry BGR555 background palette, and indexed OBJ overlays. The port keeps
that representation in typed arrays. Its software renderer writes palette
indices into the same 240x160 layout; Canvas 2D is only used to present the
converted `ImageData`.

Scene timing is reconstructed from the song's Krawall `Zxx` callbacks. Given an
audio sample position, `MCVirus.syncAt()` replays the decoded markers and derives
the current part, subpart, cue and beat counters. The AudioContext is the
playback clock. The replay engine keeps periodic snapshots so seeking only has
to restore nearby Krawall state and render forward from there.

The runtime is split into explicit ES modules with a one-way dependency graph:
generated data and constants feed the core helpers, renderer, effects, audio,
and finally the public controller. Modules communicate through named imports
and exports rather than load-order-dependent globals. `mcvirus_app.js` exposes
the frozen `MCVirus` facade only for console use and the validation workflow.
Code embedding the port can import the APIs directly:

```js
import { start, syncAt, validation } from './mcvirus.js';
```

The browser synthesizes the cartridge's Krawall song live at its native 32,768
Hz rate. A pure JavaScript player runs inside an `AudioWorklet`; the adapter
converts to the AudioContext's hardware rate when necessary. It preserves the
demo's startup silence, Direct Sound output delay, mono mixer configuration,
nearest-neighbor sampling, loops, volume envelopes, and the small set of tracker
effects this song uses.

The replay algorithms are adapted from Sebastian Kienzl's
[Krawall](https://github.com/sebknzl/krawall) library. The original copyright
notice is retained in `mcvirus_krawall.js`; that adaptation remains available
under LGPL-2.1-or-later, with the complete terms in `COPYING.Krawall`.

The source song was an XM, but Krawerter converted it before it was linked into
the cartridge. The original XM container, names, and any discarded source data
are therefore gone and cannot be recovered losslessly. `Module0.krw` and
`mc-virus.gba.krb` preserve the exact converted data that Krawall actually
played; a reconstructed XM remains useful only as an analysis aid.

## Rebuilding generated data

```text
file:   mc-virus.gba
size:   2302312 bytes (0x232168)
SHA256: 8f799c712b14938c08f956f81729704f7a687cee1c4bc151aaedd83d5cdfa03f
```

The archive inventory and sync timeline use only Python's standard library and
are deterministic:

```sh
python3 tools/analyze_rom.py mc-virus.gba --out notes
```

Rebuild every browser asset directly from that ROM:

```sh
python3 tools/build_data.py mc-virus.gba
```

`mcvirus_data.js` contains only the ROM's data archive (`0x00cd28` up to
`0x17f888`) plus decoded metadata. It deliberately excludes the ARM executable.
The same command also writes the live replay inputs:

| file | bytes | SHA-256 |
|---|---:|---|
| `Module0.krw` | 24,076 | `629b965d5f754e43366c43ac4eb31c1b4d968036380f6b5935f6c975c761b5c9` |
| `mc-virus.gba.krb` | 593,066 | `c8fae5159b443bec48cf14ce6af321c05c39257a3b68cd4b12a349966e108af2` |

The bank keeps each logical sample endpoint separate from Krawerter's 69-byte
native mixer guard. The extractor validates both generated hashes, so accidental
format or ROM changes fail the build instead of silently changing playback.

Verify the complete JavaScript replay and its seek snapshots with:

```sh
node tools/verify_krawall.mjs
```

## Reference capture and validation

The recorder is a small client for the public mGBA core API. The reference used
mGBA source commit `fa977ccbc815efc93aefad9acddc9af0577d7827`. Build that
revision (or a compatible mGBA), then compile the recorder against the same
source/build pair:

```sh
MCV_MGBA_SRC=/tmp/mgba-src
MCV_MGBA_BUILD=/tmp/mgba-build
git clone https://github.com/mgba-emu/mgba.git "$MCV_MGBA_SRC"
git -C "$MCV_MGBA_SRC" checkout fa977ccbc815efc93aefad9acddc9af0577d7827
cmake -S "$MCV_MGBA_SRC" -B "$MCV_MGBA_BUILD" \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_QT=OFF -DBUILD_SDL=OFF -DBUILD_SHARED=ON
cmake --build "$MCV_MGBA_BUILD" --parallel

cc -std=c11 -O2 -I "$MCV_MGBA_SRC/include" tools/mgba_reference.c \
  -L "$MCV_MGBA_BUILD" -lmgba -Wl,-rpath,"$MCV_MGBA_BUILD" \
  -o /tmp/mgba_reference

/tmp/mgba_reference mc-virus.gba /tmp/mcvirus-reference 12000 15
```

This produces post-composited `frame-*.ppm` images, `audio.wav`, and a
per-frame `timeline.json`. The 12,000-frame run is about 200.9 seconds at the
GBA's 59.7275 Hz frame rate. The separate GDB-stub diagnostics used the mGBA
0.10.5 application (`26b7884bc25a5933960f3cdcd98bac1ae14d42e2`).

For browser comparisons, wait for the page's validation-ready flag and call
`await MCVirus.validation.renderFrame(frameNumber)`. It renders a requested GBA
frame directly from its corresponding audio time at the internal 240x160
resolution, allowing sampled Canvas output to be compared with the recorder's
PPMs without playing the demo in real time. An optional canvas may be passed as
the second argument.

`tools/mgba_trace.py` is useful for inspecting memory through mGBA's GDB stub,
but its Python Mode-4/OBJ compositor implements only the subset needed during
analysis. The native `tools/mgba_reference.c` post-composited frames are the
visual oracle.

## Fidelity status

The ROM identity, archive boundaries, all 147 asset entries, the 169 song
markers, part ordering, sample timing, Krawall module/bank, and native reference
capture have reproducible checks. The warning sequence and all 13 dispatched
part IDs have browser implementations. Browser smoke tests over HTTP verify
asset decompression, live Krawall replay, Web Audio controls, seeking, and
sampled deterministic frame rendering.

The browser visuals use the recovered mesh, camera, palette, tunnel and scene
contracts, but pixel-for-pixel parity has not been established for the whole
demo. Treat the current visual result as a behavior-oriented port under
comparison with the native mGBA capture, not as a verified cycle-accurate
rendering.

The original work and its art/music remain credited to Matt Current and the
authors above. This repository's extraction and browser code are for preservation
and study of the released demo.

This port was made with Codex 5.6 Sol Ultra.
