# mc-virus disassembly and format notes

These notes describe the `mc-virus.gba` image used by this port. Addresses in
the `0x08000000` range are GBA ROM addresses; plain six-digit offsets are file
offsets. Runtime engine addresses in `0x03000000` are in IWRAM.

## Identity and scope

```text
size       2302312 bytes (0x232168)
SHA-256    8f799c712b14938c08f956f81729704f7a687cee1c4bc151aaedd83d5cdfa03f
title      "virus" at the usual header title field
```

This is a homebrew image and does not contain the normal Nintendo logo/header
payload. Tooling which refuses ROMs with a nonstandard commercial header must
load it as a raw ARMv4T little-endian image based at `0x08000000`.

The browser port is based on static disassembly, explicit binary parsers, and
observations from a read-only mGBA reference run. It does not translate and
execute the ROM wholesale.

## Boot and memory layout

The ROM entry path is:

```text
0x08000000 -> 0x080000c0 -> 0x080000e0
```

Startup installs `0x08000218` in the IRQ dispatcher slot at `0x03007ffc` and
uses `0x080002d8` as the demo's IRQ routine. Before entering the main program it
copies two blocks from the end of ROM:

| ROM file range | bytes | destination | role |
|---|---:|---|---|
| `0x228650..0x22d71b` | `0x50cc` | `0x03000000` | performance-sensitive engine code in IWRAM |
| `0x22d71c..0x22dedb` | `0x7c0` | `0x03005878` | initialized IWRAM globals |

The main ARM entry is `0x080003e8`. It initializes the video/engine, calls each
part's setup routine, starts Krawall, waits for VBlank, page-flips Mode 4, and
dispatches the current part's update routine. The Krawall marker callback is
`0x08000328`.

Observed sequencer globals include:

| address | meaning |
|---|---|
| `0x03005204` | current part |
| `0x03005880` | VBlank/frame counter reset at part entry |
| `0x030050d4` | copied/auxiliary part counter |
| `0x03005210` | `Z10..Z1f` cue value |
| `0x03005214` | counter captured by a `Z10..Z1f` cue |
| `0x03005218` | secondary shot/cue word |
| `0x0300521c` | subpart from `Zc0..Zcf` |
| `0x03005284` | subpart VBlank counter |
| `0x03005150` | scene-local counter sampled during validation |

The main scene dispatch table recovered from `0x080003e8` is:

| part | initialization | per-frame update |
|---:|---|---|
| 1 | `0x08180a78` | `0x08180aac` |
| 2 | `0x08181bd4` | `0x08181bdc` |
| 4 | `0x08181418` | `0x0818144c` |
| 5 | `0x08180fc8` | `0x08180ff4` |
| 6 | `0x08180608` | `0x081806c8` |
| 7 | `0x08180344` | `0x0818034c` |
| 8 | `0x08181800` | `0x08181830` |
| 9 | `0x08181e14` | `0x08181e1c` |
| 10 | `0x081823e0` | `0x081824b0` |
| 11 | `0x08182b48` | `0x08182b50` |
| 12 | `0x08182f94` | `0x08182ff0` |
| 13 | `0x081835c0` | `0x08183600` |
| 14 | `0x08183938` | `0x08183994` |

There is no dispatched part 3 in the song sequence.

The principal archive references made by those routines are:

| part | recovered scene assets |
|---:|---|
| 1 | `scene20.v/.f`, `scene20.cam`, `scene21.cam`, `scene2texture.*`, `overlay5.*`, `random.*` |
| 2 | `tunnel1u.img`, `tunnel1v.img`, `tunnel1fade.img`, `tunnel1texture.*`, `overlay4.*` |
| 4 | `scene40.v/.f`, cameras `scene40` through `scene44`, `scene4texture.*`, `overlay1.*` |
| 5 | `scene30.v/.f`, `scene31.v/.f`, `scene30.cam`, `scene31.cam`, `scene3texture.*` |
| 6 | `scene10.v/.f`, `scene11.v/.f`, cameras `scene10` through `scene12`, `scene1texture.*`, `overlay2.*` |
| 7 | the concatenated `ring.v/.f` records and full-screen `tausta2.*` |
| 8 | `palikka0.v/.f`, `env.*`, full-screen `tausta1.*`, `overlay7.*` |
| 9 | `scene50.v/.f`, `scene51.v/.f`, cameras `scene50` through `scene52`, `pallokartta.*`, `palloseinae.*`, `overlay3.*` |
| 10 | `scene60.v/.f/.cam`, `scene6texture.*`, full-screen `tausta3.*`, `overlay6.*` |
| 11 | `scene70.v/.f/.cam`, full-screen `tausta4.*`, `overlay6.*` |
| 12 | `scene80.v/.f`, `scene81.v/.f`, `scene82.v/.f`, cameras `scene80` through `scene86`, `scene8texture.*` |
| 13 | `scene90.v/.f`, `scene90.cam`, `scene91.cam`, `scene9texture.*`, full-screen `tausta5.*` and `tausta6.*` |
| 14 | `scene100.v/.f/.cam`, `scene10texture.*`, `variformbasic.img`, full-screen `tausta7.*` |

## Video path

The demo writes indexed pixels in GBA Mode 4. `DISPCNT` alternates between
`0x1444` and `0x1454`: Mode 4, BG2 and OBJ enabled, 1D OBJ tile mapping, with
the page-select bit toggled. Each visible framebuffer is `240 * 160 = 0x9600`
bytes. Background and OBJ colors are separate 256-entry BGR555 palettes.

The overlay loader at `0x0800cb8c` copies exactly `0x4000` bytes to OBJ VRAM
`0x06014000`. `0x0800cbc8` presents that upload as four consecutive 64x64,
8bpp affine sprites (the four quadrants of one 128x128 overlay):

```text
quadrant positions   (-6,-24), (114,-24), (-6,57), (114,57)
tile indices         0x200, 0x280, 0x300, 0x380
affine matrix        PA=134, PB=0, PC=0, PD=200 (signed 8.8)
```

The sprites use double-size bounds and semi-transparent OBJ mode. With the
usual `BLDCNT=0x0490` and `BLDALPHA=0x1f1f` call, hardware clips both blend
coefficients to 16 and performs channel-wise saturated addition of OBJ and
BG2. The Canvas compositor reproduces that BGR555 addition.

The principal IWRAM helpers are:

| address | operation |
|---|---|
| `0x03000084` | transform a 256-color BGR555 palette |
| `0x03000390` | copy one `0x9600`-byte Mode-4 frame |
| `0x03000418` | fill a Mode-4 frame with an 8-bit palette index |
| `0x03000494` | unwrap a mesh record and enter the mesh renderer |
| `0x03000eac` | sort and flush queued triangles |
| `0x0300197c` | Catmull-Rom camera-track sample |
| `0x030024d0` | tunnel mapper |
| `0x03002a14` | row-major Q8 4x4 matrix multiply |
| `0x03002acc` | camera sampling/view setup |
| `0x03002bbc` | normalize camera direction |
| `0x03002c84` | build the view matrix at `0x03005320` |

For the equal red/green/blue adjustments used by every scene, the palette
operation on each five-bit component is:

```js
let base = 16 + ((contrastQ8 * (component - 16)) >> 8);
let out = adjust < 0
  ? (((adjust + 256) * base) >> 8)
  : (base + (adjust >> 3));
out = Math.max(0, Math.min(31, out));
```

The ordinary additive OBJ overlays use the following per-frame palette
parameters. `f` is the part counter and `A`/`C` are the signed adjustment and
Q8 contrast passed to `0x03000084`:

| part | OBJ asset | adjustment `A` | contrast `C` |
|---:|---|---|---:|
| 1 | `overlay5` | `max(-256, f<128 ? 2*f-256 : f>900 ? 2*(900-f) : 0)` | `256+(f&0x33)` |
| 2 | `overlay4` | `0` | `256` |
| 4 | `overlay1` | `0` | `256` |
| 6 | `overlay2` | `0` | `256` |
| 8 | `overlay7` | `(max(0,256-8*beatAge)*350 >> 8)-256`, after frame 128; otherwise `-256` | `256` |
| 9 | `overlay3` | `0` through frame 450, then the scene fade plus `450-f` | `256` |
| 10 | `overlay6` | `-(sin[f*200]+255)/2` | `256` |
| 11 | `overlay6` | `min(f-255,0)-200` | `256` |

Part 14 is a separate feedback overlay. It uploads `variformbasic.img`, samples
blue-channel differences between the Mode-4 page about to be overwritten and
`tausta7.img` into a 16x16 field, applies two five-tap cross blurs, and writes
the resulting values as a grayscale OBJ palette. Because Mode 4 alternates two
pages, the sampled indexed image is the frame rendered two updates earlier,
while the background palette is the globally active palette from the previous
update.

## Private asset archive

The ROM has no filesystem. Its private archive has these anchors:

```text
data base          file 0x00cd28 / ROM 0x0800cd28
directory          file 0x17f888 / ROM 0x0817f888
directory length   0x967 bytes
directory end      0x1801ef
entries            147
```

The directory starts with a little-endian `u32` byte length. Each following
entry is a little-endian `u32` offset relative to `0x00cd28`, then a NUL-ended
ASCII name. An asset's size is the next entry's relative offset minus its own;
the final asset ends at the directory. Several names are zero-sized aliases and
share the following asset's offset. In particular, do not parse those aliases
as camera records.

`tools/analyze_rom.py` implements this parser. The complete, generated inventory
is in `ASSET_MANIFEST.tsv`.

Common asset forms are:

| suffix | recovered form |
|---|---|
| `.pal` | 256 little-endian GBA BGR555 colors, normally `0x200` bytes |
| full-screen `.img` | 240x160 palette indices, `0x9600` bytes |
| texture `.img` | 256x256 palette indices, `0x10000` bytes |
| overlay `.img` | normally 128x128 palette indices, `0x4000` bytes |
| `.tab` | 32x256 shade/remap table, `0x2000` bytes |
| `.cam` | six signed 32-bit camera tracks |
| `.v` / `.f` | one or more mesh vertex/face records |

### Mesh records

`.v` and `.f` can concatenate multiple records. `ring.v` and `ring.f` use this;
standalone records commonly have a trailing `0xffff` sentinel.

```text
.v record
  u16 vertexCount
  repeat vertexCount:
    s16 x, y, z
    s16 nx, ny, nz
    s16 u, v

.f record
  u16 triangleCount
  repeat triangleCount:
    u16 a5, b5, c5
```

Normals are signed Q8 (`normal / 256`). Texture coordinates are signed Q4
texels and wrap modulo 256. Face members are not vertex indices: each is a
multiple of five and represents a word offset into the renderer's five-word
transformed-vertex record. Consumers must use `rawFace / 5`.

The span writer receives the two scratch fields in reverse argument order. For
stored vertex fields `u` then `v`, the affine rasterizer's exact address is:

```js
texture[((v >> 4) & 255) * 256 + ((u >> 4) & 255)]
```

The second stored coordinate is therefore the texture row/high byte. The engine
uses painter sorting by average camera depth and no z-buffer. Its mesh modes are:

| mode | behavior |
|---:|---|
| 0 | queued/sorted flat triangle; material selects an even palette index |
| 1 | marker/non-drawing queue case |
| 2 | queued/sorted texture mapping with stored UVs |
| 3 | queued/sorted environment mapping from the rotated normal |
| 4 | immediate textured triangle |
| 5 | immediate flat triangle |

For mode 3, stored UVs are ignored and the engine computes fixed-point column
`u = nx*8 + 2048` and row `v = ny*8 + 2048`. Normals receive model rotation
only, not the camera basis.

Renderer flag 1 enables the screen-space winding test; flag 3 reverses its
accepted sign. With screen Y increasing downward, the ordinary configuration
keeps `cross(B-A,C-A) <= 0`. Modes 4 and 5 rasterize immediately in stored face
order; only modes 0, 2 and 3 enter the painter queue.

Renderer flag 4 selects a lower-resolution textured-span branch in
`0x03001708`. Scanline interiors are halfword-aligned, but the branch issues one
`STRB` for each two-pixel interior pair and advances the affine UV interpolants
by two pixels. As with the tunnel mapper, VRAM replicates that byte across the
whole halfword, so both pixels receive the left/even sample. An odd left edge
and an even final pixel use halfword read/modify/write and remain independent.
This pairing is especially visible on part 10's immediate-mode arrow textures.

The 32x256 `.tab` files are used by flat polygons, not as a texture filter.
`0x080008d8` stores the current table pointer at `0x03005280`; the flat span
writer then shades the pixel already in the Mode-4 page as:

```js
framebuffer[x] = table[((material & 31) << 8) | framebuffer[x]];
```

If the pointer is null, it fills with the material's palette index instead.
This destination remap is what makes the part-7 rings and several flying
shards shade their copied backgrounds rather than appear as solid-color faces.

### Camera records

Every real camera is `0x3c4` bytes:

```text
u32 count                 // 40 throughout this ROM
s32 eyeX[count]
s32 eyeY[count]
s32 eyeZ[count]
s32 targetX[count]
s32 targetY[count]
s32 targetZ[count]
```

The camera function treats its parameter as signed 24.8 fixed point, adds
`0x200`, then samples four adjacent points with Catmull-Rom interpolation. This
means parameter zero begins at control point 3. For a 40-point track, the safe
ordinary range is `-0x200 <= t < 35*256`; part 1 deliberately uses the negative
prefix.

The native sampler has no count or bounds check. The final part-6 `scene12`
shot reaches parameter `9660`, so its last sample reads three signed words past
each nominal track: tracks 0 through 4 continue into the following track, and
track 5 continues into `scene3texture.pal`. The browser camera parser retains
those three contiguous guard words and the sampler preserves the ARM routine's
signed 32-bit overflow and rounding.

A floating-point equivalent is:

```js
function sampleTrack(a, tQ8) {
  const q = tQ8 + 0x200;
  const i = q >> 8;
  const t = (q & 255) / 256;
  const [p0, p1, p2, p3] = [a[i], a[i + 1], a[i + 2], a[i + 3]];
  return 0.5 * (
    2 * p1 +
    (-p0 + p2) * t +
    (2*p0 - 5*p1 + 4*p2 - p3) * t*t +
    (-p0 + 3*p1 - 3*p2 + p3) * t*t*t
  );
}
```

In ordinary mesh coordinates, divide the sampled eye and target tracks by four.
The renderer converts each model vertex to camera-world axes as
`[x, -z, -y]`; a conventional look-at camera with world up `[0, 1, 0]` then
matches the recovered coordinate system.

### Tunnel mapper

Part 2 combines `tunnel1u.img` and `tunnel1v.img` into a 65,536-entry map:

```js
uvMap[i] = tunnel1u[i] | (tunnel1v[i] << 8);
```

`0x030024d0` rotates and scales an affine window through that map, then uses the
mapped 16-bit value plus one wrapping packed texture offset to sample
`tunnel1texture.img`. The low-byte U addition deliberately carries into V. The
demo passes `tunnel1fade.img`, scale `0x5c`, and non-additive mode. In that fade
path the ARM loop evaluates only 120 samples per row and issues `STRB` stores at
even VRAM addresses (`0, 2, ... 238`). VRAM is connected through a 16-bit bus:
an 8-bit store is replicated into both bytes of the addressed halfword. Each
sample therefore produces a two-pixel horizontal pair; treating VRAM as
ordinary byte-addressable memory creates false alternating vertical stripes.

### Part 10 arrow ordering

Part 10 builds 25 packed sort records before drawing its arrow grid. For build
cell `n = 0..24`, the record is:

```js
((((height(n) + 255) & 0xffff) << 16) | (n + 1)) >>> 0
```

`0x081823e4` quicksorts these records descending by the unsigned high 16-bit
key. It is not a stable sort, so its swaps also determine the order of tied
heights. The draw loop then uses the packed low-half ID directly, without
subtracting one, and recomputes the cell as `row = trunc(id / 6)` and
`column = id - row * 6`. Thus the key made from cell 0 deliberately draws cell
1, through the key made from cell 24 drawing cell 25. Preserving that native
off-by-one ID mapping is necessary for the scene's overlap order and layout.

## Krawall song and sync reconstruction

The song root is file offset `0x226aec`. Recovered module facts are:

```text
channels                 12
orders                   34
patterns                 34
global volume            128
initial speed            6 ticks/row
BPM field                174
mix rate                 32768 Hz
integer tick length      468 samples
row length               2808 samples
effective tempo          175.042735042735 BPM
rows processed           2176
Zxx markers              169
```

Krawall truncates the tick calculation and aligns it to a four-sample mixer
quantum. This module contains no speed, tempo, position-jump, pattern-break,
loop, or pattern-delay effects, so every row has a fixed duration. A marker on
global row `r` is called at:

```text
sample_from_krapPlay = 468 + r * 2808
```

The final row is processed and channels stop at sample `6107868`, or
`186.397338867` seconds after `krapPlay`.

Callback `0x08000328` gives `Zxx` these semantics:

| marker | action |
|---|---|
| `Z00` | increment beat count and capture the part-frame counter |
| `Z10..Z1f` | set cue 0..15 and capture its timestamp |
| `Z20..Z2f` | set secondary cue 0..15 |
| `Zc0..Zcf` | set subpart 0..15 and reset its counter |
| `Zf0..Zff` | set part 0..15 and reset the part counters |

The timestamps captured by `Z00` and `Z10..Z1f` are part-local counter values,
not elapsed wall-clock ages. Those captures survive an `Fxx` reset, and markers
on the same tracker row execute in channel order. Palette routines therefore
use the signed difference `currentPartFrame - capturedPartFrame`; it can be
negative immediately after a part cut and is responsible for several long
white entry flashes.

The part-marker sequence by global row is:

```text
1@0, 7@256, 1@383, 7@448, 5@512, 9@640, 5@768,
2@896, 6@960, 2@1024, 6@1088, 4@1151, 10@1311,
8@1408, 12@1663, 10@1727, 12@1763, 13@1791,
14@1920, 11@2048
```

In the native reference, `krapPlay` begins at captured output sample `143820`
(`4.389038086` seconds). The first part marker occurs 468 samples later at
absolute sample `144288` (`4.403320313` seconds). The browser adds this startup
offset before replaying the relative marker list.

`tools/analyze_rom.py` parses the packed pattern event stream and regenerates
`SYNC_TIMELINE.tsv`, including all marker channels, rows, samples, VBlank
equivalents and decoded semantics.

## Krawall data and browser replay

The cartridge does not contain a playable source tracker file. Its module flags
(`flagInstrumentBased=1`, `flagLinearSlides=1`) identify an XM origin—the
Krawerter S3M path always emits a sample-based module—but Krawerter transformed
that source before linking it into the ROM. Original names and container bytes
were discarded; unused or duplicate material may have been removed, short loops
were extended, and 16-bit sources could have been reduced to 8-bit PCM. An
original XM therefore cannot be recovered losslessly.

The exact browser inputs are instead KRWM/KRWB containers around the converted
data Krawall actually consumed:

| runtime input | bytes | SHA-256 |
|---|---:|---|
| `Module0.krw` | 24,076 | `629b965d5f754e43366c43ac4eb31c1b4d968036380f6b5935f6c975c761b5c9` |
| `mc-virus.gba.krb` | 593,066 | `c8fae5159b443bec48cf14ce6af321c05c39257a3b68cd4b12a349966e108af2` |

The underlying ROM layout is:

| content | file offset / range | count or form |
|---|---|---|
| sample records | first at `0x190198` | 32 unsigned 8-bit PCM records |
| sample pointer table | `0x21e7a8` | 32 ROM pointers |
| instrument records | `0x21e828..0x220e27` | 32 records, `0x130` stride |
| instrument pointer table | `0x220e28` | 32 ROM pointers |
| pattern records | `0x220ea8..0x226aeb` | 34 packed 64-row patterns |
| module root | `0x226aec` | 364-byte header |
| pattern pointer table | `0x226c58` | 34 ROM pointers |

Each packed sample begins with an 18-byte header: `u32 loopLength`, `u32 end`,
`u32 c2Freq`, signed fine tune and relative note, default volume and panning,
loop mode, and the HQ flag. PCM bytes are unsigned and centered at 128. Krawerter
places a 69-byte guard after the logical endpoint because the native mixer can
advance as many as 17 source bytes for each of four aligned output samples.
`tools/extract_krawall.py` keeps `Sample.end` at the logical boundary while
retaining that physical guard up to the next bank pointer.

This distinction fixes an off-by-18 error in UnkrawerterGBA 4.0's direct KRWB
writer, which absorbs part of the guard into the logical sample and consequently
moves loop starts. The generated bank's guards were checked against all three
native forms: constant 128 for unlooped samples, data from loop start for forward
loops, and reversed tail data for bidirectional loops. Converting the corrected
bank/module pair back through Unkrawerter produces the same reconstructed XM as
a direct ROM conversion, apart from the XM title.

The native initialization sequence calls `kragInit(0)` for mono output,
`kramQualityMode(0x20)` for nearest-neighbor mixing with stop ramps disabled,
installs callback `0x08000328`, and calls `krapPlay` with mode and song both zero.
The GBA exposes two output channels, but the captured left and right samples are
identical. The song uses only four Krawall effect IDs:

| effect | events | operands |
|---|---:|---|
| XM volume slide (`7`) | 1,075 | `02`, `0a`, `0f` |
| tone portamento (`19`) | 4 | `ff` |
| sample offset (`27`) | 48 | `00`, `02`, `10` |
| marker (`36`) | 169 | the `Zxx` values in `SYNC_TIMELINE.tsv` |

`mcvirus_krawall.js` ports that sequencer, the used volume envelopes, loop
handling, and the native-rate mono mixer. `mcvirus_krawall_worklet.js` runs it in
an `AudioWorklet` and converts from 32,768 Hz when the AudioContext uses another
hardware rate. The replay retains the startup silence and Direct Sound buffer
delay; periodic state snapshots make seeking practical without prerendering the
whole song. Browser playback therefore requires Web Audio and `AudioWorklet` on
localhost or another secure context, and a launch gesture to unlock audio.

For comparison, UnkrawerterGBA commit
[`999e310fcc62a0d21e783549051a06a2a3fbd848`](https://github.com/MCJack123/UnkrawerterGBA/commit/999e310fcc62a0d21e783549051a06a2a3fbd848)
can reconstruct a synthetic `Module0.xm`. This ROM requires `-K`, the 2005-04-21
layout. That XM is 630,362 bytes with SHA-256
`9626b50c4b7a98aeefcbf75ed98170667604f2f3f84caf432b3d9e194678cafc`,
but it drops Krawall-only marker effects and a normal XM player does not reproduce
the native mixer. It remains an analysis artifact, not a runtime input.

## Reproducing analysis and reference captures

Generate stable archive/song reports directly from the ROM:

```sh
python3 tools/analyze_rom.py mc-virus.gba --out notes
```

Regenerate the browser archive module and both exact Krawall runtime inputs
directly from the same ROM:

```sh
python3 tools/build_data.py mc-virus.gba
```

The builder validates the ROM and the generated KRWM/KRWB hashes before it
writes `mcvirus_data.js`, `Module0.krw`, and `mc-virus.gba.krb`.

`tools/DecompileFunctions.java` exports Ghidra decompilation for explicitly
seeded entry points. Import the ROM as raw `ARM:LE:32:v4t` at `0x08000000`, then
run, for example (replace `analyzeHeadless` with Ghidra's full support-script
path if it is not on `PATH`):

```sh
analyzeHeadless /tmp/mcvirus-ghidra mcvirus \
  -import "$PWD/mc-virus.gba" -overwrite \
  -processor ARM:LE:32:v4t -loader BinaryLoader \
  -loader-baseAddr 0x08000000

analyzeHeadless /tmp/mcvirus-ghidra mcvirus \
  -process mc-virus.gba -noanalysis \
  -scriptPath "$PWD/tools" \
  -postScript DecompileFunctions.java /tmp/mcvirus-scenes.c \
  0818034c 081806c8 08180aac 08180ff4 0818144c 08181830 \
  08181bdc 08181e1c 081824b0 08182b50 08182ff0 08183600 08183994
```

Functions in the copied engine block must be mapped at their IWRAM destination
(`0x03000000` plus their block offset), not only at the corresponding ROM source
bytes.

For the native visual/audio/state oracle, build
[mGBA](https://github.com/mgba-emu/mgba) at the reference revision
[`fa977ccbc815efc93aefad9acddc9af0577d7827`](https://github.com/mgba-emu/mgba/commit/fa977ccbc815efc93aefad9acddc9af0577d7827),
then build the small recorder against that same source/build pair:

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

The recorder uses mGBA's post-composited video callback, so its PPMs include
hardware OBJ composition. It also records the native stereo samples and the
sequencer globals above on every video frame. Reference outputs are development
artifacts in `/tmp`, not repository inputs.

The alternate `tools/mgba_trace.py` connects to mGBA's GDB stub at the frame-loop
breakpoint `0x080004e0` and can sample RAM, VRAM, palette RAM and OAM. Its Python
renderer is diagnostic; it should not replace the native post-composited frames
for final comparisons. Those GDB traces used the mGBA 0.10.5 application build
`26b7884bc25a5933960f3cdcd98bac1ae14d42e2`; the final headless capture used the
source revision pinned above.

## Known fidelity boundary

The binary parsers and timing calculations are exact for the identified ROM and
have stable generated reports. The engine contracts above come from both
disassembly and asset-range checks. The Canvas implementation uses those
contracts, but whole-demo pixel identity has not yet been demonstrated. In
particular, fixed-point rounding, winding/culling, sprite priority, affine
texture edge rules, and the tunnel's retained alternate pixels can produce
visible differences even when the high-level scene is correct.
