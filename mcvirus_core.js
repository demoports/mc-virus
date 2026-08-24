// Archive loader, indexed framebuffer, palettes, and sync-state replay.
import { MCV_EMBEDDED } from './mcvirus_data.js';
import {
  SCREEN_WIDTH as W,
  SCREEN_HEIGHT as H,
  FRAMEBUFFER_PIXELS as PIXELS,
  AUDIO_SAMPLE_RATE as GBA_RATE,
  GBA_FRAMES_PER_SECOND as GBA_FPS,
  KRAP_PLAY_SAMPLE,
} from './mcvirus_constants.js';

const KRAWALL = MCV_EMBEDDED.krawall;

export function base64Bytes(value) {
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; ++i) bytes[i] = decoded.charCodeAt(i);
  return bytes;
}

async function gunzip(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('This browser needs DecompressionStream (or run a current Chrome, Edge, Firefox, or Safari).');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class Assets {
  constructor(bytes, entries) {
    this.bytes = bytes;
    this.entries = new Map(entries.map(([name, offset, size]) => [name, { offset, size }]));
    this.cache = new Map();
  }

  has(name) { return this.entries.has(name); }

  raw(name) {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`missing ROM asset: ${name}`);
    return this.bytes.subarray(entry.offset, entry.offset + entry.size);
  }

  palette(name) {
    const key = `pal:${name}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const source = this.raw(name);
    const palette = new Uint16Array(256);
    const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
    for (let i = 0; i < 256 && i * 2 + 1 < source.length; ++i) palette[i] = view.getUint16(i * 2, true);
    this.cache.set(key, palette);
    return palette;
  }

  image(name) { return this.raw(name); }

  shadeTable(name) {
    const key = `tab:${name}`;
    if (!this.cache.has(key)) this.cache.set(key, this.raw(name));
    return this.cache.get(key);
  }

  camera(name) {
    const key = `cam:${name}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const entry = this.entries.get(name);
    const source = this.raw(name);
    if (source.byteLength < 4) return null;
    const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
    const count = view.getUint32(0, true);
    const tracks = [];
    const archive = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    for (let track = 0; track < 6; ++track) {
      const offset = entry.offset + 4 + track * count * 4;
      // The ARM spline helper does not know the camera's point count. A few
      // late paths intentionally run beyond their final point, reading into
      // the next track (and, for track 5, the following ROM asset). Retain a
      // small slice of that contiguous data so those native tails survive.
      const available = Math.max(0, Math.floor((this.bytes.byteLength - offset) / 4));
      const length = Math.min(count + 3, available);
      const values = new Int32Array(length);
      for (let i = 0; i < length; ++i) values[i] = archive.getInt32(offset + i * 4, true);
      tracks.push(values);
    }
    const camera = { count, tracks };
    this.cache.set(key, camera);
    return camera;
  }

  mesh(verticesName, facesName, record = 0) {
    const key = `mesh:${verticesName}:${facesName}:${record}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const vb = this.raw(verticesName), fb = this.raw(facesName);
    const vv = new DataView(vb.buffer, vb.byteOffset, vb.byteLength);
    const fv = new DataView(fb.buffer, fb.byteOffset, fb.byteLength);
    let vo = 0, fo = 0, vertexCount = 0, faceCount = 0;
    for (let r = 0; r <= record; ++r) {
      vertexCount = vv.getUint16(vo, true); vo += 2;
      if (r !== record) vo += vertexCount * 16;
      faceCount = fv.getUint16(fo, true); fo += 2;
      if (r !== record) fo += faceCount * 6;
    }
    const vertices = new Int16Array(vertexCount * 8);
    for (let i = 0; i < vertices.length; ++i) vertices[i] = vv.getInt16(vo + i * 2, true);
    const faces = new Uint16Array(faceCount * 3);
    for (let i = 0; i < faces.length; ++i) {
      // The archive stores a word offset into the engine's five-word
      // transformed-vertex record, not an ordinary vertex index.
      const wordOffset = fv.getUint16(fo + i * 2, true);
      faces[i] = wordOffset / 5;
    }
    const mesh = { vertices, faces, vertexCount, faceCount };
    this.cache.set(key, mesh);
    return mesh;
  }
}

function adjustChannel(channel, amount, contrast) {
  let value = ((contrast * (channel - 16)) >> 8) + 16;
  if (amount < 0) value = ((amount + 256) * value) >> 8;
  else value += amount >> 3;
  return Math.max(0, Math.min(31, value));
}

export class Framebuffer {
  constructor() {
    this.pixels = new Uint8Array(PIXELS);
    this.palette = new Uint16Array(256);
    this.rgba = new Uint32Array(PIXELS);
    this.paletteLut = new Uint32Array(256);
    this.spriteColors = new Uint16Array(PIXELS);
    this.spriteMask = new Uint8Array(PIXELS);
  }

  clear(index = 0) { this.pixels.fill(index & 255); }

  clearSprites() { this.spriteMask.fill(0); }

  copy(image) { this.pixels.set(image.subarray(0, PIXELS)); }

  setPalette(source) { this.palette.set(source.subarray(0, 256)); }

  transformPaletteInto(target, source, red = 0, green = 0, blue = 0, contrast = 256) {
    for (let i = 0; i < 256; ++i) {
      const color = source[i];
      const r = adjustChannel(color & 31, red, contrast);
      const g = adjustChannel((color >> 5) & 31, green, contrast);
      const b = adjustChannel((color >> 10) & 31, blue, contrast);
      target[i] = r | (g << 5) | (b << 10);
    }
  }

  transformPalette(source, red = 0, green = 0, blue = 0, contrast = 256) {
    this.transformPaletteInto(this.palette, source, red, green, blue, contrast);
  }

  fadePalette(source, value) {
    value = Math.max(0, Math.min(256, value | 0));
    this.transformPalette(source, value - 256, value - 256, value - 256, 256);
  }

  drawImage(image, width, height, x, y, transparent = 0) {
    x |= 0; y |= 0;
    for (let sy = 0; sy < height; ++sy) {
      const dy = y + sy;
      if (dy < 0 || dy >= H) continue;
      let si = sy * width;
      for (let sx = 0; sx < width; ++sx, ++si) {
        const dx = x + sx, color = image[si];
        if (dx >= 0 && dx < W && color !== transparent) this.pixels[dy * W + dx] = color;
      }
    }
  }

  drawImageScaled(image, sourceWidth, sourceHeight, x, y, width, height, transparent = 0, additive = false) {
    const x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0);
    const x1 = Math.min(W, Math.ceil(x + width)), y1 = Math.min(H, Math.ceil(y + height));
    for (let dy = y0; dy < y1; ++dy) {
      const sy = Math.max(0, Math.min(sourceHeight - 1, ((dy - y) * sourceHeight / height) | 0));
      for (let dx = x0; dx < x1; ++dx) {
        const sx = Math.max(0, Math.min(sourceWidth - 1, ((dx - x) * sourceWidth / width) | 0));
        const color = image[sy * sourceWidth + sx];
        if (color === transparent) continue;
        const at = dy * W + dx;
        this.pixels[at] = additive ? Math.min(255, this.pixels[at] + color) : color;
      }
    }
  }

  drawSprite(image, spritePalette, sourceWidth = 128, sourceHeight = 128,
    x = 56, y = 16, width = 128, height = 128, transparent = 0) {
    const x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0);
    const x1 = Math.min(W, Math.ceil(x + width)), y1 = Math.min(H, Math.ceil(y + height));
    for (let dy = y0; dy < y1; ++dy) {
      const sy = clampInt(((dy - y) * sourceHeight / height) | 0, 0, sourceHeight - 1);
      for (let dx = x0; dx < x1; ++dx) {
        const sx = clampInt(((dx - x) * sourceWidth / width) | 0, 0, sourceWidth - 1);
        // OBJ graphics are 8bpp 8x8 tiles. The 128x128 overlays are
        // uploaded as four consecutive 64x64 sprites, so each quadrant
        // owns 64 consecutive tiles rather than sharing 16-tile rows.
        const tile = sourceWidth === 128 && sourceHeight === 128
          ? ((sy >> 6) * 2 + (sx >> 6)) * 64 + ((sy & 63) >> 3) * 8 + ((sx & 63) >> 3)
          : (sy >> 3) * (sourceWidth >> 3) + (sx >> 3);
        const index = image[tile * 64 + (sy & 7) * 8 + (sx & 7)];
        if (index === transparent) continue;
        const at = dy * W + dx;
        this.spriteColors[at] = spritePalette[index];
        this.spriteMask[at] = 1;
      }
    }
  }

  toRGBA() {
    for (let i = 0; i < 256; ++i) {
      const color = this.palette[i];
      const r = ((color & 31) * 255 / 31) | 0;
      const g = (((color >> 5) & 31) * 255 / 31) | 0;
      const b = (((color >> 10) & 31) * 255 / 31) | 0;
      this.paletteLut[i] = 0xff000000 | (b << 16) | (g << 8) | r;
    }
    for (let i = 0; i < PIXELS; ++i) this.rgba[i] = this.paletteLut[this.pixels[i]];
    for (let i = 0; i < PIXELS; ++i) {
      if (!this.spriteMask[i]) continue;
      // 0x0800cbc8 configures semi-transparent OBJ as the first blend
      // target and BG2 as the second, with coefficients that saturate at
      // 16/16. In BGR555 this is a channel-wise saturated addition.
      const background = this.palette[this.pixels[i]];
      const sprite = this.spriteColors[i];
      const color = Math.min(31, (background & 31) + (sprite & 31)) |
        (Math.min(31, ((background >> 5) & 31) + ((sprite >> 5) & 31)) << 5) |
        (Math.min(31, ((background >> 10) & 31) + ((sprite >> 10) & 31)) << 10);
      const r = ((color & 31) * 255 / 31) | 0;
      const g = (((color >> 5) & 31) * 255 / 31) | 0;
      const b = (((color >> 10) & 31) * 255 / 31) | 0;
      this.rgba[i] = 0xff000000 | (b << 16) | (g << 8) | r;
    }
    return this.rgba;
  }
}
function clampInt(value, low, high) { return value < low ? low : value > high ? high : value; }

export function syncAt(seconds) {
  seconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const sample = Math.max(0, Math.floor(seconds * GBA_RATE));
  const state = {
    sample, part: -1, partSample: 0, subpart: 0, subpartSample: 0,
    cue10: 0, cue10Sample: 0, cue10PartFrame: 0, cue20: 0,
    beatCount: 0, beatSample: 0, beatPartFrame: 0,
  };
  const partFrameAt = eventSample => Math.max(0,
    Math.floor((eventSample - state.partSample) * GBA_FPS / GBA_RATE));
  for (const [relativeSample, value] of KRAWALL.markers) {
    const eventSample = KRAP_PLAY_SAMPLE + relativeSample;
    if (eventSample > sample) break;
    if (value === 0) {
      state.beatCount++;
      state.beatSample = eventSample;
      state.beatPartFrame = partFrameAt(eventSample);
    }
    else if (value >= 0x10 && value <= 0x1f) {
      state.cue10 = value - 0x10;
      state.cue10Sample = eventSample;
      state.cue10PartFrame = partFrameAt(eventSample);
    }
    else if (value >= 0x20 && value <= 0x2f) state.cue20 = value - 0x20;
    else if (value >= 0xc0 && value <= 0xcf) { state.subpart = value - 0xc0; state.subpartSample = eventSample; }
    else if (value >= 0xf0 && state.part !== value - 0xf0) {
      state.part = value - 0xf0;
      state.partSample = eventSample;
    }
  }
  state.frame = Math.max(0, Math.floor((sample - state.partSample) * GBA_FPS / GBA_RATE) + 1);
  state.subpartFrame = Math.max(0, Math.floor((sample - state.subpartSample) * GBA_FPS / GBA_RATE) + 1);
  state.cue10Frame = Math.max(0, Math.floor((sample - state.cue10Sample) * GBA_FPS / GBA_RATE) + 1);
  state.beatFrame = Math.max(0, Math.floor((sample - state.beatSample) * GBA_FPS / GBA_RATE) + 1);
  // Z00 and Z10 store the current part-local callback counter in the ROM.
  // Fxx resets the current counter but deliberately leaves those captures
  // intact, so these deltas can be negative immediately after a part cut.
  state.cue10DeltaFrame = state.frame - state.cue10PartFrame;
  state.beatDeltaFrame = state.frame - state.beatPartFrame;
  return state;
}

let assetsPromise;

export function loadAssets() {
  if (!assetsPromise) {
    assetsPromise = unpackAssets().catch((error) => {
      assetsPromise = undefined;
      throw error;
    });
  }
  return assetsPromise;
}

async function unpackAssets() {
  const bytes = await gunzip(base64Bytes(MCV_EMBEDDED.archiveGzipBase64));
  if (bytes.length !== MCV_EMBEDDED.archiveLength) {
    throw new Error('Corrupt embedded mc-virus archive.');
  }
  return new Assets(bytes, MCV_EMBEDDED.assets);
}
