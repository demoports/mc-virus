// Deterministic reconstruction of the ROM scene callbacks.
import {
  SCREEN_WIDTH as W,
  SCREEN_HEIGHT as H,
  GBA_FRAMES_PER_SECOND,
  KRAP_PLAY_SAMPLE,
} from './mcvirus_constants.js';
import { Framebuffer, syncAt } from './mcvirus_core.js';
import { Renderer } from './mcvirus_engine.js';

const TAU = Math.PI * 2;
const clamp = (value, low, high) => value < low ? low : value > high ? high : value;
const sin14 = value => Math.sin((value & 0x3fff) * TAU / 0x4000) * 256;
const sinI = value => Math.trunc(sin14(value));

// 0x081823e4 quicksorts part 10's packed records descending by the
// unsigned high half only. Reproducing its swaps matters when heights tie.
function sortArrowRecords(records, low, high) {
  if (high <= low) return;
  const pivot = records[high] >>> 16;
  let left = low - 1, right = high;
  for (;;) {
    do { ++left; } while ((records[left] >>> 16) > pivot && left <= high);
    do { --right; } while ((records[right] >>> 16) < pivot && right >= low);
    if (left >= right) break;
    const swap = records[left];
    records[left] = records[right];
    records[right] = swap;
  }
  const swap = records[left];
  records[left] = records[high];
  records[high] = swap;
  sortArrowRecords(records, low, left - 1);
  sortArrowRecords(records, left + 1, high);
}

export class Effects {
  constructor(assets) {
    if (!assets) throw new Error('Effects needs loaded mc-virus assets.');
    this.assets = assets;
    this.fb = new Framebuffer();
    this.renderer = new Renderer(this.fb);
    this.cache = new Map();
    this.lastState = null;
    this.lastSeconds = 0;
    this.introEndSample = KRAP_PLAY_SAMPLE + 468;
    this.pageHistory = [];
    this.lastRenderedFrame = -1;
    this.variformLastPalette = null;
  }

  image(name) {
    const key = `image:${name}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const value = this.assets.has(name) ? this.assets.image(name) : null;
    this.cache.set(key, value);
    return value;
  }

  palette(name) {
    const key = `palette:${name}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const value = this.assets.has(name) ? this.assets.palette(name) : null;
    this.cache.set(key, value);
    return value;
  }

  shade(name) {
    const key = `shade:${name}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const value = this.assets.has(name) ? this.assets.shadeTable(name) : null;
    this.cache.set(key, value);
    return value;
  }

  camera(name) {
    const key = `camera:${name}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const value = this.assets.has(name) && this.assets.raw(name).byteLength
      ? this.assets.camera(name)
      : null;
    this.cache.set(key, value);
    return value;
  }

  mesh(name, record = 0) {
    const key = `mesh:${name}:${record}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const verticesName = `${name}.v`;
    const facesName = `${name}.f`;
    const value = this.assets.has(verticesName) && this.assets.has(facesName)
      ? this.assets.mesh(verticesName, facesName, record)
      : null;
    this.cache.set(key, value);
    return value;
  }

  resetRenderer() {
    const r = this.renderer;
    r.setTexture(null);
    r.setFlatTable(null);
    r.setTranslation(0, 0, 0);
    r.setRotation(0, 0, 0);
    r.setRoll(0);
    r.setScale(0);
    r.setProjection(0x780, 0x500, 0);
    r.flags.fill(0);
    // Scenes without a .cam use the engine's direct projection path. This
    // equivalent camera keeps their model-space dimensions useful in JS.
    r.camera = { eye: [0, 0, -5000], target: [0, 0, 0] };
  }

  setFlags(values) {
    this.renderer.flags.fill(0);
    for (const [index, value] of Object.entries(values)) {
      this.renderer.flags[index | 0] = value | 0;
    }
  }

  setCamera(name, parameter = 0) {
    const camera = this.camera(name);
    if (!camera) return false;
    this.renderer.setCamera(camera, parameter | 0);
    return true;
  }

  setSceneTexture(base, table = false) {
    const texture = this.image(`${base}.img`);
    this.renderer.setTexture(texture);
    this.renderer.setFlatTable(table ? this.shade(`${base}.tab`) : null);
    return texture;
  }

  copyBackground(base) {
    const image = this.image(`${base}.img`);
    if (image) this.fb.copy(image);
    else this.fb.clear(0);
  }

  darkestIndex(name) {
    const key = `darkest:${name}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const palette = this.palette(name);
    let result = 0, best = Infinity;
    if (palette) {
      for (let i = 0; i < 256; ++i) {
        const color = palette[i];
        const luma = (color & 31) * 3 + ((color >> 5) & 31) * 6 + ((color >> 10) & 31) * 2;
        if (luma < best) { best = luma; result = i; }
      }
    }
    this.cache.set(key, result);
    return result;
  }

  sprite(base, brightness = 256, options = {}) {
    const image = this.image(`${base}.img`);
    const source = options.palette || this.palette(`${base}.pal`);
    if (!image || !source) return;
    const suppliedPalette = !!options.palette;
    const transformed = options.adjust !== undefined || options.red !== undefined ||
      options.green !== undefined || options.blue !== undefined || options.contrast !== undefined;
    const level = clamp(brightness, 0, 384) | 0;
    if (!suppliedPalette && !transformed && level <= 0) return;
    const red = (options.red === undefined ? (options.adjust || 0) : options.red) | 0;
    const green = (options.green === undefined ? (options.adjust || 0) : options.green) | 0;
    const blue = (options.blue === undefined ? (options.adjust || 0) : options.blue) | 0;
    const contrast = (options.contrast === undefined ? 256 : options.contrast) | 0;
    const key = suppliedPalette ? null : transformed
      ? `sprite-palette:${base}:x:${red}:${green}:${blue}:${contrast}`
      : `sprite-palette:${base}:s:${level}`;
    let palette = suppliedPalette ? source : this.cache.get(key);
    if (!palette) {
      palette = new Uint16Array(256);
      if (transformed) {
        // The cartridge's 0x03000084 helper applies signed brightness and
        // Q8 contrast with arithmetic shifts; OBJ palettes use it too.
        this.fb.transformPaletteInto(palette, source, red, green, blue, contrast);
      } else {
        for (let i = 0; i < 256; ++i) {
          const color = source[i];
          const r = clamp(Math.round((color & 31) * level / 256), 0, 31);
          const g = clamp(Math.round(((color >> 5) & 31) * level / 256), 0, 31);
          const b = clamp(Math.round(((color >> 10) & 31) * level / 256), 0, 31);
          palette[i] = r | (g << 5) | (b << 10);
        }
      }
      this.cache.set(key, palette);
    }
    // 0x0800cbc8 lays the upload out as four 64x64 OBJ sprites. All four
    // share affine matrix PA=134, PB=0, PC=0, PD=200 and use double-size
    // 128x128 bounds. Lower OAM indices win where the bounds overlap.
    for (let quadrant = 3; quadrant >= 0; --quadrant) {
      const objectX = (quadrant & 1) ? 114 : -6;
      const objectY = (quadrant & 2) ? 57 : -24;
      const x0 = Math.max(0, objectX), y0 = Math.max(0, objectY);
      const x1 = Math.min(W, objectX + 128), y1 = Math.min(H, objectY + 128);
      for (let dy = y0; dy < y1; ++dy) {
        const sy = ((200 * (dy - objectY - 64)) >> 8) + 32;
        if (sy < 0 || sy >= 64) continue;
        for (let dx = x0; dx < x1; ++dx) {
          const sx = ((134 * (dx - objectX - 64)) >> 8) + 32;
          if (sx < 0 || sx >= 64) continue;
          const tile = quadrant * 64 + (sy >> 3) * 8 + (sx >> 3);
          const index = image[tile * 64 + (sy & 7) * 8 + (sx & 7)];
          if (index === (options.transparent || 0)) continue;
          const at = dy * W + dx;
          this.fb.spriteColors[at] = palette[index];
          this.fb.spriteMask[at] = 1;
        }
      }
    }
  }

  // 0x081801f0 and the sampling loop in part 14 turn differences between
  // the two Mode-4 pages into a 16x16 grayscale OBJ palette. Each index in
  // variformbasic.img selects one cell from this field.
  makeVariformPalette(pixels, background, colorPalette, pulse) {
    const field = new Int32Array(256);
    for (let cellY = 0; cellY < 16; ++cellY) {
      const sampleY = cellY * 10;
      for (let cellX = 0; cellX < 16; ++cellX) {
        const sampleX = 2 * Math.floor(cellX * 15 / 2);
        let difference = 0;
        for (let oy = 0; oy <= 3; oy += 3) {
          for (let ox = 0; ox <= 6; ox += 6) {
            const at = (sampleY + oy) * W + sampleX + ox;
            difference += ((colorPalette[pixels[at]] >> 10) & 31) -
              ((colorPalette[background[at]] >> 10) & 31);
          }
        }
        field[cellY * 16 + cellX] = Math.max(0, (pulse * difference) >> 8);
      }
    }

    let source = field;
    for (let pass = 0; pass < 2; ++pass) {
      const filtered = new Int32Array(256);
      for (let y = 0; y < 16; ++y) {
        for (let x = 0; x < 16; ++x) {
          const center = source[y * 16 + x];
          const left = source[y * 16 + Math.max(0, x - 1)];
          const right = source[y * 16 + Math.min(15, x + 1)];
          const up = source[Math.max(0, y - 1) * 16 + x];
          const down = source[Math.min(15, y + 1) * 16 + x];
          filtered[y * 16 + x] = Math.floor((center + left + right + up + down) / 5);
        }
      }
      source = filtered;
    }

    const palette = new Uint16Array(256);
    for (let i = 0; i < 256; ++i) {
      const value = Math.min(source[i], 31);
      palette[i] = value | (value << 5) | (value << 10);
    }
    return palette;
  }

  rememberPageFrame(frame) {
    if (this.lastRenderedFrame === frame) {
      if (this.pageHistory.length) {
        const entry = this.pageHistory[this.pageHistory.length - 1];
        entry.pixels.set(this.fb.pixels);
      }
      return;
    }
    if (this.lastRenderedFrame !== frame - 1) this.pageHistory.length = 0;
    const entry = this.pageHistory.length >= 2
      ? this.pageHistory.shift()
      : { frame: 0, pixels: new Uint8Array(W * H) };
    entry.frame = frame;
    entry.pixels.set(this.fb.pixels);
    this.pageHistory.push(entry);
    this.lastRenderedFrame = frame;
  }

  draw(name, mode = 2, color = 6, record = 0, options = {}) {
    const mesh = this.mesh(name, record);
    if (mesh) this.renderer.drawMesh(mesh, mode, color, options);
  }

  renderAt(seconds) {
    seconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    this.currentAbsoluteFrame = Math.floor(seconds * GBA_FRAMES_PER_SECOND + 1e-7);
    const state = syncAt(seconds);
    this.lastState = state;
    this.lastSeconds = seconds;
    this.fb.clearSprites();
    this.fb.spriteColors.fill(0);
    this.resetRenderer();

    if (state.sample < this.introEndSample || state.part < 0) {
      this.renderIntro(seconds);
      this.rememberPageFrame(this.currentAbsoluteFrame);
      return this.fb;
    }

    switch (state.part) {
      case 1: this.part1(state); break;
      case 2: this.part2(state); break;
      case 4: this.part4(state); break;
      case 5: this.part5(state); break;
      case 6: this.part6(state); break;
      case 7: this.part7(state); break;
      case 8: this.part8(state); break;
      case 9: this.part9(state); break;
      case 10: this.part10(state); break;
      case 11: this.part11(state); break;
      case 12: this.part12(state); break;
      case 13: this.part13(state); break;
      case 14: this.part14(state); break;
      default: this.fb.clear(0); this.fb.palette.fill(0); break;
    }
    this.rememberPageFrame(this.currentAbsoluteFrame);
    return this.fb;
  }

  renderIntro(seconds) {
    const frame = Math.floor(seconds * GBA_FRAMES_PER_SECOND);
    const image = this.image('intro.img'), source = this.palette('intro.pal');
    if (!image || !source) {
      this.fb.clear(0);
      this.fb.palette.fill(frame <= 12 ? 0x7fff : 0);
      return;
    }
    this.fb.copy(image);
    let adjust = 0;
    if (frame <= 12) adjust = 255;
    else if (frame <= 40) adjust = Math.max(255 - 32 * (Math.floor((frame - 13) / 4) + 1), 0);
    else if (frame >= 202) adjust = Math.max(-16 * (Math.floor((frame - 202) / 4) + 1), -240);
    this.fb.transformPalette(source, adjust, adjust, adjust, 256);
  }

  // 0x08180aac — rusted corridor and the large scene20 camera path.
  part1(state) {
    const f = state.frame;
    this.setFlags({ 0: 1, 1: 1, 2: 1, 3: 0, 4: 1, 5: 1, 7: 0, 8: 1 });
    this.fb.clear(this.darkestIndex('scene2texture.pal'));
    const scenePalette = this.palette('scene2texture.pal');
    const random = this.image('random.img');
    let randomIndex = 3;
    if (state.cue20 === 0) {
      if (f <= 672) randomIndex = 0;
      else if (f <= 832) randomIndex = 1;
      else if (f <= 1240) randomIndex = 2;
    }
    const randomValue = random ? random[randomIndex & 63] : 1;
    const period = randomValue === 0 ? 1 : randomValue << 3;
    const remainder = f % period;
    const dipWidth = random ? Math.floor(random[(randomIndex + 500) & 63] / 6) : 0;
    const randomDip = remainder > period - dipWidth ? 12 : 0;
    const paletteAdjust = (Math.min((f >> 1) - 31, 0) - randomDip) * 8;
    if (scenePalette) this.fb.transformPalette(scenePalette,
      paletteAdjust, paletteAdjust, paletteAdjust, 256 + (f & 0x3c));
    this.setSceneTexture('scene2texture');
    this.renderer.setProjection(0x780, 0x500, 0);
    this.renderer.setRoll(sin14(f * 15) * 2);
    if (state.cue20 === 0) this.setCamera('scene20.cam', f * 5 - 400);
    else this.setCamera('scene21.cam', f * 20 + 0x578);
    this.draw('scene20', 2, 6);
    // The second shot disables OBJ blending in the cartridge callback.
    if (state.cue20 === 0) {
      let adjust = f < 128 ? f * 2 - 256 : 0;
      if (f > 900) adjust = (900 - f) * 2;
      this.sprite('overlay5', 256, {
        adjust: Math.max(-256, adjust), contrast: 256 + (f & 0x33),
      });
    }
  }

  // 0x08181bdc — Krawall-driven UV tunnel.
  part2(state) {
    const f = state.frame;
    const u = this.image('tunnel1u.img'), v = this.image('tunnel1v.img');
    const rawTexture = this.image('tunnel1texture.img');
    const texture = rawTexture && rawTexture.subarray(0, 0x10000);
    const fade = this.image('tunnel1fade.img');
    const tunnelPalette = this.palette('tunnel1texture.pal');
    const tunnelAdjust = Math.min(f * 3 - 255, 0);
    if (tunnelPalette) this.fb.transformPalette(tunnelPalette,
      tunnelAdjust, tunnelAdjust, tunnelAdjust, 256);
    if (u && v && texture) {
      let rotation, offset;
      if (state.subpart === 0) {
        rotation = sinI(f * 0x15) * 0x0c - sinI(f * 0x0c + 0x1bb8) * 0x19;
        offset = (f >> 1) & 255;
      } else {
        rotation = sinI(f * 0x1f + 3000) * 0x17 - sinI(f * 0x19 + 0x1000) * 10;
        offset = 100 | (((f >> 1) & 255) << 8);
      }
      // The fade path issues one STRB per two output pixels. GBA VRAM is a
      // 16-bit bus, so that byte is replicated across the addressed
      // halfword; drawTunnel mirrors the sample into both Canvas pixels.
      this.renderer.drawTunnel(u, v, texture, fade, rotation | 0, 0x5c, offset, false);
    }
    this.sprite('overlay4', 256, { adjust: 0, contrast: 256 });
  }

  // 0x0818144c — white modular architecture with five recovered cameras.
  part4(state) {
    const f = state.frame;
    this.setFlags({ 0: 1, 1: 1, 2: 0, 3: 0, 4: 1, 5: 1, 6: 0, 7: 0 });
    // The native callback clears Mode 4 to palette index 1; in this scene's
    // palette that entry is pure white and is part of the composition.
    this.fb.clear(1);
    const scenePalette = this.palette('scene4texture.pal');
    const beatAge = state.beatDeltaFrame;
    const sceneAdjust = state.subpart === 0 ? Math.max(256 - beatAge * 6, 0) : 0;
    if (scenePalette) this.fb.transformPalette(scenePalette,
      sceneAdjust, sceneAdjust, sceneAdjust, 256);
    this.setSceneTexture('scene4texture', false);
    let camera = 'scene42.cam', parameter = 0;
    if (state.cue20 === 1) camera = 'scene43.cam';
    else if (state.cue20 === 2) camera = 'scene44.cam';
    else if (state.cue20 >= 3) {
      camera = state.subpart ? 'scene41.cam' : 'scene40.cam';
      parameter = state.subpartFrame * (state.subpart ? 0x19 : 0x12);
    }
    this.setCamera(camera, parameter);
    this.renderer.setRoll(state.cue20 >= 3 ? sin14(f * 10 + 0x3ec) * 5 : 0);
    this.draw('scene40', 2, 6);
    this.sprite('overlay1', 256, { adjust: 0, contrast: 256 });
  }

  // 0x08180ff4 — spinning room plus drifting scene31 blocks.
  part5(state) {
    const f = state.frame;
    this.setFlags({ 0: 0, 1: 1, 2: 1, 3: 0, 4: 1, 5: 1, 6: 0, 7: 0 });
    this.fb.clear(this.darkestIndex('scene3texture.pal'));
    this.fb.setPalette(this.palette('scene3texture.pal'));
    this.setSceneTexture('scene3texture', true);
    this.renderer.setRoll(sin14(f * 0x1c) * 6);
    this.setCamera(state.subpart === 0 ? 'scene30.cam' : 'scene31.cam', f * 0x0d);
    this.draw('scene30', 2, 6);

    this.renderer.setTexture(null);
    this.renderer.flags[1] = 0;
    this.renderer.flags[2] = 0;
    this.renderer.flags[7] = 1;
    const weights = [6, 2, 1, 6];
    for (let i = 0; i < 4; ++i) {
      this.renderer.setRotation(0, -(f + (((f + 0x16bb) * weights[i]) >> 3)) * 0x2d,
        sin14(f * 100 - 3000 + i * 2000));
      this.renderer.setTranslation(0, -90000 + i * 60000, 0);
      const shade = clamp(31 - state.beatDeltaFrame +
        ((sin14(f * 80 - 9000 + i * 6000) + 255) >> 5), 0, 30);
      this.draw('scene31', 5, shade);
    }
  }

  // 0x081806c8 — the scene1 chamber, ring and planar foreground.
  part6(state) {
    const f = state.frame;
    this.setFlags({ 0: 0, 1: 1, 2: 1, 3: 0, 4: 1, 5: 1, 6: 0, 7: 0, 8: 0 });
    this.fb.clear(this.darkestIndex('scene1texture.pal'));
    const scenePalette = this.palette('scene1texture.pal');
    const subpartAge = state.subpartFrame;
    const introBoost = subpartAge < 32 ? 256 - subpartAge * 8 : 0;
    // The second native entry finishes setup at counter 5. Its Z10 ramp is
    // therefore (f - 5 - cueCapture) * 4 and begins slightly dark at -16.
    const cueBoost = state.cue20 === 1 ? (state.cue10DeltaFrame - 5) * 4 : 0;
    if (scenePalette) this.fb.transformPalette(scenePalette,
      introBoost + cueBoost, introBoost + cueBoost, introBoost + cueBoost,
      introBoost * 2 + 256);
    this.setSceneTexture('scene1texture');
    this.renderer.setProjection(0x780, 0x500, 0);
    if (state.subpart === 0) {
      this.setCamera('scene11.cam', 0);
      this.renderer.setRoll(f + 0x400);
      this.renderer.flags[7] = 1;
      this.renderer.setRotation(0, -Math.max(state.subpartFrame - 1, 0) * 0x23, 0);
    } else if (state.subpart === 1) {
      this.setCamera('scene10.cam', state.subpartFrame * 0x23 + 0x5dc);
    } else {
      this.setCamera('scene12.cam', state.subpartFrame * 0x1e);
    }
    this.draw('scene11', 4, 6);
    this.renderer.flags[0] = 1;
    this.renderer.flags[2] = 1;
    this.renderer.flags[8] = 1;
    this.draw('scene10', 2, 6);
    this.sprite('overlay2', 256, { adjust: 0, contrast: 256 });
  }

  // 0x0818034c — flat, independently rotating rings over tausta2.
  part7(state) {
    const f = state.frame;
    this.setFlags({ 0: 0, 1: 0, 2: 0, 3: 0, 5: 0, 6: 1, 7: 0, 8: 2 });
    this.copyBackground('tausta2');
    const fadeAdjust = Math.min(f * 5 - 256, 0);
    const pulseAge = state.beatDeltaFrame;
    const entryPulse = state.subpart === 0 ? Math.max(128 - pulseAge * 2, 0) : 0;
    const backgroundAdjust = fadeAdjust + entryPulse;
    const backgroundPalette = this.palette('tausta2.pal');
    if (backgroundPalette) this.fb.transformPalette(backgroundPalette,
      backgroundAdjust, backgroundAdjust, backgroundAdjust, 256);
    this.renderer.setFlatTable(this.shade('tausta2.tab'));
    this.renderer.setProjection(0x780, 0x500, 16000);
    this.renderer.flags[5] = 0;
    this.renderer.setScale(0x200);
    for (let i = 0; i < 4; ++i) {
      const phase = 5000 + i * 5000 + f * 12 + state.subpart * 10000;
      this.renderer.setTranslation(0, 0, 0);
      this.renderer.setRotation(phase >> 1, phase * 3, phase);
      const shade = clamp(Math.floor((sin14(phase * 0x18) + 255) / 20), 0, 30);
      this.draw('ring', 5, shade);
    }
  }

  // 0x08181830 — normal-mapped star over the tausta1 information card.
  part8(state) {
    const f = state.frame;
    this.setFlags({ 0: 1, 1: 1, 2: 1, 4: 0, 5: 0, 6: 0, 7: 0 });
    this.copyBackground('tausta1');
    const beatAge = state.beatDeltaFrame;
    const beatPulse = f > 128 ? Math.max(256 - beatAge * 8, 0) : 0;
    const backgroundAdjust = Math.min(f * 2 - 256, 0) + (beatPulse >> 1);
    const backgroundPalette = this.palette('tausta1.pal');
    if (backgroundPalette) this.fb.transformPalette(backgroundPalette,
      backgroundAdjust, backgroundAdjust, backgroundAdjust, beatPulse + 256);
    this.setSceneTexture('env');
    this.renderer.flags[5] = 0;
    this.renderer.setScale(0x200);
    this.renderer.setTranslation(0, 0, 0);
    this.renderer.setProjection(sin14(Math.min(f * 10, 0x1000)) * 6 - 0x136,
      0x500, 15000 - Math.min(f * 10, 5000));
    this.renderer.setRotation(sin14(f * 15 + 0x1000) * 12 - f * 30,
      f * 25, sin14(f * 19) * 10);
    this.draw('palikka0', 3, 6);
    const overlayAdjust = ((beatPulse * 0x15e) >> 8) - 256;
    this.sprite('overlay7', 256, { adjust: overlayAdjust, contrast: 256 });
  }

  // 0x08181e1c — globe and tiled spherical wall.
  part9(state) {
    const f = state.frame;
    this.setFlags({ 0: 0, 1: 1, 2: 1, 3: 0, 4: 1, 5: 1, 6: 0, 7: 0, 8: 2 });
    this.fb.clear(this.darkestIndex('pallokartta.pal'));
    const subpartAge = state.subpartFrame;
    let paletteAdjust = f < 64 ? f * 4 - 256 : 0;
    if (f >= 64 && subpartAge < 32) paletteAdjust = subpartAge * 8 - 256;
    const globePalette = this.palette('pallokartta.pal');
    if (globePalette) this.fb.transformPalette(globePalette,
      paletteAdjust, paletteAdjust, paletteAdjust, 256);
    this.setSceneTexture('palloseinae');
    this.renderer.setRoll(-sin14(f * 0x1e + sin14(f * 0x37) * 10) * 2);
    let camera = 'scene50.cam', parameter = state.subpartFrame * 0x28 + 500;
    if (state.subpart === 1) { camera = 'scene51.cam'; parameter = state.subpartFrame * 0x23; }
    else if (state.subpart >= 2) { camera = 'scene52.cam'; parameter = state.subpartFrame * 0x17 + 900; }
    this.setCamera(camera, parameter);
    if (state.subpart === 1) this.renderer.setRotation(0, f * 0x1e, 0);
    this.draw('scene50', 2, 6);

    this.setSceneTexture('pallokartta');
    this.renderer.flags[2] = 0;
    this.renderer.flags[4] = 0;
    this.renderer.flags[7] = 1;
    this.renderer.setRotation(0, state.subpart === 1 ? 10000 - f * 0x14 : -f * 0x28, 0);
    this.draw('scene51', 2, 7);
    const overlayAdjust = f < 451 ? 0 : paletteAdjust + 450 - f;
    this.sprite('overlay3', 256, { adjust: overlayAdjust, contrast: 256 });
  }

  // 0x081824b0 — 25-item undulating grid of the orange arrow quad.
  part10(state) {
    const f = state.frame;
    this.setFlags({ 0: 0, 1: 1, 2: 1, 3: 0, 4: 1, 5: 1, 7: 1, 8: 2 });
    this.copyBackground('tausta3');
    const sceneAdjust = Math.max(256 - f * 5, 0);
    const scenePalette = this.palette('scene6texture.pal');
    if (scenePalette) this.fb.transformPalette(scenePalette,
      sceneAdjust, sceneAdjust, sceneAdjust, 256);
    this.setSceneTexture('scene6texture');
    this.setCamera('scene60.cam', 0);
    this.renderer.setScale(0x80);
    this.renderer.setRotation(0, sinI(f * 0x0f) * 0x0f, 0);
    const phaseX = (f * 4) & 255;
    const phase = sinI(f * 8) * 4 + 0x3fc;
    const phaseCell = Math.trunc(phase / 256);
    const timeCell = Math.trunc(f / 64);
    const arrowAt = id => {
      const row = Math.trunc(id / 6);
      const column = id - row * 6;
      const x0 = column * 256 - 0x240;
      const z0 = row * 256 - 0x240;
      const inner = sinI((z0 - phaseCell * 256) * 5);
      const height = sinI((x0 - timeCell * 256 + inner + f) * 100);
      return { x0, z0, height };
    };

    // Native first builds keys from zero-based cells, packs IDs 1..25,
    // then reconstructs each draw from that one-based ID without subtracting
    // one. It is an intentional off-by-one in the original scene.
    const records = new Uint32Array(26);
    for (let id = 0; id < 25; ++id) {
      const height = arrowAt(id).height;
      records[id + 1] = (((((height + 0xff) & 0xffff) << 16) >>> 0) | (id + 1)) >>> 0;
    }
    sortArrowRecords(records, 1, 25);
    for (let sorted = 1; sorted <= 25; ++sorted) {
      const arrow = arrowAt(records[sorted] & 0xffff);
      this.renderer.setTranslation((arrow.x0 + phaseX) * 0x28a,
        arrow.height * 0x96, (arrow.z0 + (phase & 255)) * 0x28a);
      this.draw('scene60', 4, 6);
    }
    // The ROM's byte offset is f*400 into an s16 table: f*200 samples.
    const overlayAdjust = Math.trunc(-(sinI(f * 200) + 255) / 2);
    this.sprite('overlay6', 256, { adjust: overlayAdjust, contrast: 256 });
  }

  // 0x08182b50 — black extruded forms over the built-in credit plate.
  part11(state) {
    const f = state.frame;
    this.setFlags({ 0: 0, 1: 1, 2: 1, 3: 0, 5: 1, 6: 0, 7: 1 });
    this.copyBackground('tausta4');
    const fadeAdjust = Math.min(f - 255, 0);
    const backgroundPalette = this.palette('tausta4.pal');
    if (backgroundPalette) this.fb.transformPalette(backgroundPalette,
      fadeAdjust, fadeAdjust, fadeAdjust, 256);
    this.renderer.camera = { eye: [0, 0, -5000], target: [0, 0, 0] };
    this.setCamera('scene70.cam', 0);
    this.renderer.setProjection(0x780, 0x820, 0);
    this.renderer.setRotation(0, f * 0x11, 0);
    this.draw('scene70', 5, 0);
    this.sprite('overlay6', 256, { adjust: fadeAdjust - 200, contrast: 256 });
  }

  // 0x08182ff0 — scene8 architecture, seven cue-selected camera splines.
  part12(state) {
    const f = state.frame;
    this.setFlags({ 0: 1, 1: 1, 2: 1, 3: 0, 4: 1, 5: 1, 7: 0, 8: 1 });
    this.fb.clear(255);
    const scenePalette = this.palette('scene8texture.pal');
    const cutAge = state.subpartFrame;
    const cutPulse = state.subpart > 1 ? Math.max(128 - cutAge * 8, 0) : 0;
    if (scenePalette) this.fb.transformPalette(scenePalette,
      cutPulse, cutPulse, cutPulse, cutPulse * 2 + 256);
    this.setSceneTexture('scene8texture', true);
    const cameraIndex = clamp(state.subpart, 0, 6);
    const cameraName = `scene${80 + cameraIndex}.cam`;
    let parameter = 0;
    if (cameraIndex === 0) parameter = f * 0x14;
    else if (cameraIndex === 1) parameter = f * 20;
    this.setCamera(cameraName, parameter);
    this.draw('scene82', 2, 6);

    this.renderer.setTexture(null);
    this.renderer.flags[0] = 0;
    this.renderer.flags[1] = 0;
    this.renderer.flags[2] = 0;
    this.renderer.flags[7] = 1;
    for (let i = 0; i < 3; ++i) {
      const motion = state.subpart === 0 ? f : 2 * f + 5000;
      const q = 630 + 630 * i + (((460 + 230 * i) * motion) >> 9);
      const wrapped = q - Math.floor(q / 800) * 800;
      this.renderer.setTranslation((wrapped - 400) * 3400, 240000 - i * 80000, 0);
      const shade = clamp((sin14(5000 + i * 5000 + f * 50) + 255) >> 5, 0, 30);
      this.draw('scene81', 5, shade);
    }
    this.setSceneTexture('scene8texture', true);
    this.renderer.flags[0] = 1;
    this.renderer.flags[1] = 1;
    this.renderer.flags[2] = 1;
    this.renderer.flags[7] = 0;
    this.draw('scene80', 2, 6);
  }

  // 0x08183600 — scene9 mesh composited over alternating tausta5/tausta6.
  part13(state) {
    const f = state.frame;
    this.setFlags({ 0: 1, 1: 1, 2: 0, 3: 0, 4: 1, 5: 1, 7: 1, 8: 1 });
    const background = state.subpart === 0 ? 'tausta5' : 'tausta6';
    this.copyBackground(background);
    const beatAge = state.beatDeltaFrame;
    let beatPulse = clamp(256 - beatAge * 8, 0, 256);
    if (state.subpart === 1) beatPulse = Math.trunc(beatPulse / 3);
    const scenePalette = this.palette('scene9texture.pal');
    if (scenePalette) this.fb.transformPalette(scenePalette,
      beatPulse, beatPulse, beatPulse, beatPulse * 2 + 256);
    this.setSceneTexture('scene9texture', false);
    this.renderer.setRotation(0, f * 0x2d, 0);
    this.renderer.setProjection(0x780, 0x500, 0);
    if (state.subpart === 0) {
      this.setCamera('scene90.cam', state.subpartFrame * 0x1b);
      this.renderer.setRoll(0xed8);
    } else {
      this.setCamera('scene91.cam', state.subpartFrame * 0x1a + 0x15e);
      this.renderer.setRoll(0);
    }
    this.draw('scene90', 2, 6);
  }

  // 0x08183994 — final scene100 shards over the tausta7 logo plate.
  part14(state) {
    const f = state.frame;
    this.setFlags({ 0: 1, 1: 1, 2: 0, 3: 0, 4: 0, 5: 1, 7: 1, 8: 1 });
    const background = this.image('tausta7.img');
    const scenePalette = this.palette('scene10texture.pal');
    const beatAge = state.beatDeltaFrame;
    const beatPulse = Math.max(256 - beatAge * 6, 0);
    const absoluteFrame = this.currentAbsoluteFrame;
    const sameFrame = this.lastRenderedFrame === absoluteFrame;
    const sequential = this.lastRenderedFrame === absoluteFrame - 1;
    let variformPalette = sameFrame ? this.variformLastPalette : null;
    if (!variformPalette && sequential && this.pageHistory.length >= 2 && background) {
      // Mode 4 alternates pages, so the page about to be overwritten holds
      // the image rendered two updates earlier. Palette RAM is global and
      // still contains the previous update's colors at this point.
      variformPalette = this.makeVariformPalette(
        this.pageHistory[0].pixels, background, this.fb.palette, beatPulse);
    }

    if (scenePalette) {
      if (f <= 1) {
        this.fb.transformPalette(scenePalette, 255, 255, 255, 256);
      } else {
        const sceneAge = state.subpartFrame;
        const palettePulse = Math.max(256 - sceneAge * 4, 0) + (beatPulse >> 3);
        this.fb.transformPalette(scenePalette,
          palettePulse, palettePulse, palettePulse, palettePulse + 256);
      }
    }
    if (background) this.fb.copy(background);
    else this.fb.clear(0);
    this.setSceneTexture('scene10texture', false);
    this.setCamera('scene100.cam', 0);
    if (state.subpart === 0) {
      this.renderer.setRotation(0, f * 0x23, 0);
      this.renderer.setRoll(0);
      this.renderer.setProjection(0xaa0 - (sin14(f * 0x32) + 255) / 2,
        0x500 - sin14(f * 0x50) / 2, 0);
    } else {
      this.renderer.setRotation(sin14(f * 0x21 + 0x3c9f) * 5 + 0x4fb,
        sin14(f * 0x14 + 0x158f) * 0x0f + 0xef1,
        sin14(f * 0x32) * 10 + 0x9f6);
      this.renderer.setRoll(f * 5);
      this.renderer.setProjection(sin14(f * 0x1e) * 2 + 0x8de,
        0x500 - sin14(f * 0x32) / 2, 0);
    }
    this.draw('scene100', 2, 6);

    if (f > 1 && background) {
      // A direct seek has no emulated page history. Deriving the same field
      // from the just-rendered page gives a deterministic first result; the
      // exact two-page feedback takes over after two sequential updates.
      if (!variformPalette) {
        variformPalette = this.makeVariformPalette(
          this.fb.pixels, background, this.fb.palette, beatPulse);
      }
      this.sprite('variformbasic', 256, { palette: variformPalette });
    }
    this.variformLastPalette = variformPalette;
  }
}

export const createEffects = assets => new Effects(assets);
