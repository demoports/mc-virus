// Fixed-resolution software 3D renderer and special-effect primitives.
import {
  SCREEN_WIDTH as W,
  SCREEN_HEIGHT as H,
} from './mcvirus_constants.js';

const TAU = Math.PI * 2;

const clamp = (x, lo, hi) => x < lo ? lo : x > hi ? hi : x;
const angle = value => (value & 0x3fff) * TAU / 0x4000;

// Vertex transforms in 0x030004d4 do not use the same apparent axes as
// the normal helper at 0x03001bac. These helpers preserve both native
// orders instead of forcing them through one conventional Euler matrix.
function rotateVertex(x, y, z, rotation) {
  let s = Math.sin(angle(rotation[1])), cosine = Math.cos(angle(rotation[1]));
  [x, z] = [cosine * x + s * z, cosine * z - s * x];
  s = Math.sin(angle(rotation[2])); cosine = Math.cos(angle(rotation[2]));
  [x, y] = [cosine * x - s * y, cosine * y + s * x];
  s = Math.sin(angle(rotation[0])); cosine = Math.cos(angle(rotation[0]));
  [y, z] = [cosine * y + s * z, cosine * z - s * y];
  return [x, y, z];
}

function rotateNormal(x, y, z, rotation) {
  let s = Math.sin(angle(rotation[1])), cosine = Math.cos(angle(rotation[1]));
  [x, z] = [cosine * x + s * z, cosine * z - s * x];
  s = Math.sin(angle(rotation[0])); cosine = Math.cos(angle(rotation[0]));
  [y, z] = [cosine * y + s * z, cosine * z - s * y];
  s = Math.sin(angle(rotation[2])); cosine = Math.cos(angle(rotation[2]));
  [x, y] = [cosine * x - s * y, cosine * y + s * x];
  return [x, y, z];
}

function normalize(x, y, z) {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

// 0x0300197c. The helper returns eight times the Catmull-Rom sample and
// its caller doubles that value. Mesh coordinates enter the same matrix
// multiplied by 64, so ordinary browser-side camera coordinates are /4.
function splineTrack(track, parameter) {
  const fixed = (parameter | 0) + 0x200;
  let index = fixed >> 8;
  const fraction = fixed & 255;
  // Parsed tracks include the contiguous guard words the count-less native
  // helper can read. This clamp is only a malformed-data safety boundary.
  index = clamp(index, 0, track.length - 4);
  const p0 = track[index], p1 = track[index + 1], p2 = track[index + 2], p3 = track[index + 3];

  // Preserve every signed 32-bit multiply, wrap and arithmetic shift from
  // the ARM routine. This is normally only a sub-pixel distinction, but the
  // late scene12 path reads packed palette words and depends on the overflow.
  const fractionSquared = Math.imul(fraction, fraction) >> 8;
  const linear = (Math.imul(p2, 0x100) + Math.imul(p0, -0x100)) | 0;
  const quadratic = (Math.imul(p0, 0x200) + Math.imul(p1, -0x500) +
    Math.imul(p2, 0x400) + Math.imul(p3, -0x100)) | 0;
  const cubic = (Math.imul(p1, 0x300) + Math.imul(p0, -0x100) +
    Math.imul(p2, -0x300) + Math.imul(p3, 0x100)) | 0;
  const value = ((Math.imul(fraction, linear) >> 8) + Math.imul(p1, 0x200) +
    (Math.imul(fractionSquared, quadratic) >> 8) +
    (Math.imul(Math.imul(fraction, fractionSquared) >> 8, cubic) >> 8)) | 0;
  const sample8 = ((value - (value >> 31)) | 0) >> 6;
  return sample8 / 32;
}

export function cameraAt(camera, parameter) {
  if (!camera) return { eye: [0, 0, -20000], target: [0, 0, 0] };
  const p = camera.tracks.map(track => splineTrack(track, parameter));
  return { eye: [p[0], p[1], p[2]], target: [p[3], p[4], p[5]] };
}

export class Renderer {
  constructor(framebuffer) {
    this.fb = framebuffer;
    this.texture = null;
    this.flatTable = null;
    this.camera = { eye: [0, 0, -20000], target: [0, 0, 0] };
    this.translation = [0, 0, 0];
    this.rotation = [0, 0, 0];
    this.roll = 0;
    this.projectionScale = 0;
    this.centerX = 120;
    this.centerY = 80;
    this.projectionDepth = 0;
    this.flags = new Int8Array(9);
    this.flags.fill(1);
    this.flags[3] = 0;
  }

  setTexture(texture) { this.texture = texture; }
  setFlatTable(table) { this.flatTable = table; }
  setCamera(camera, parameter) { this.camera = cameraAt(camera, parameter); }
  setTranslation(x, y, z) { this.translation[0] = x; this.translation[1] = y; this.translation[2] = z; }
  setRotation(first, second, third) {
    this.rotation[0] = first | 0;
    this.rotation[1] = second | 0;
    this.rotation[2] = third | 0;
  }
  setRoll(value) { this.roll = value | 0; }
  setScale(value) {
    // Raw Q8 depth multiplier used only when renderer flag 6 is enabled.
    this.projectionScale = value | 0;
  }
  setProjection(x, y, z = 0) {
    this.centerX = x / 16;
    this.centerY = y / 16;
    this.projectionDepth = z;
  }
  viewBasis() {
    const eye = this.camera.eye, target = this.camera.target;
    const forward = normalize(target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]);
    let right = normalize(-forward[2], 0, forward[0]);
    if (Math.abs(forward[0]) + Math.abs(forward[2]) < 1e-6) right = [0, 0, 0];
    const up = normalize(
      right[1] * forward[2] - right[2] * forward[1],
      right[2] * forward[0] - right[0] * forward[2],
      right[0] * forward[1] - right[1] * forward[0]
    );
    return { eye, forward, right, up };
  }

  transformMesh(mesh, mode) {
    const vertices = mesh.vertices;
    const output = new Array(mesh.vertexCount);
    const basis = this.viewBasis();
    for (let i = 0; i < mesh.vertexCount; ++i) {
      const at = i * 8;
      const cameraPath = !!this.flags[5];
      let cx, cy, cz;
      if (cameraPath) {
        // Exported world coordinates are [x,-z,-y]. Translation and Euler
        // rotation are deliberately ignored unless flag 7 is set.
        let p = [vertices[at], -vertices[at + 2], -vertices[at + 1]];
        if (this.flags[7]) {
          p[0] -= this.translation[0] / 64;
          p[1] -= this.translation[1] / 64;
          p[2] -= this.translation[2] / 64;
          p = rotateVertex(p[0], p[1], p[2], this.rotation);
        }
        const x = p[0] - basis.eye[0];
        const y = p[1] - basis.eye[1];
        const z = p[2] - basis.eye[2];
        cx = x * basis.right[0] + y * basis.right[1] + z * basis.right[2];
        cy = x * basis.up[0] + y * basis.up[1] + z * basis.up[2];
        cz = x * basis.forward[0] + y * basis.forward[1] + z * basis.forward[2];
      } else {
        // Direct branch: translation arguments map to X/Z/Y in the engine,
        // and model Z enters negated at 32 native units per model unit.
        const p = rotateVertex(
          this.translation[0] + vertices[at] * 32,
          this.translation[1] - vertices[at + 2] * 32,
          this.translation[2] + vertices[at + 1] * 32,
          this.rotation
        );
        cx = p[0];
        cy = p[1];
        // The native multiply remains Q8 until the final >>11, equivalent
        // to dividing this already-normalized rotated coordinate by eight.
        const baseDepth = this.projectionDepth * 2 + p[2] / 8;
        cz = this.flags[6]
          ? this.projectionScale * baseDepth / 256
          : baseDepth / 2;
      }
      if (cameraPath && this.roll) {
        const s = Math.sin(angle(this.roll)), c = Math.cos(angle(this.roll));
        [cx, cy] = [c * cx - s * cy, s * cx + c * cy];
      }
      const normal = rotateNormal(vertices[at + 3] / 256, vertices[at + 4] / 256,
        vertices[at + 5] / 256, this.rotation);
      const nx = normal[0], ny = normal[1], nz = normal[2];
      // Keep the native signed Q4 values through interpolation. Field 7 is
      // the texture row/high byte; field 6 is the column/low byte.
      let u = vertices[at + 6];
      let v = vertices[at + 7];
      if (mode === 3) {
        u = nx * 2048 + 2048;
        v = ny * 2048 + 2048;
      }
      output[i] = { cx, cy, z: cz, u, v, nx, ny, nz, cameraPath };
    }
    return output;
  }

  drawMesh(mesh, mode = 2, color = 6, options = {}) {
    if (mode === 1) return;
    const transformed = this.transformMesh(mesh, mode);
    const faces = mesh.faces;
    const queue = [];
    for (let i = 0; i < mesh.faceCount; ++i) {
      const a = transformed[faces[i * 3]], b = transformed[faces[i * 3 + 1]], c = transformed[faces[i * 3 + 2]];
      if (!a || !b || !c) continue;
      const near = a.cameraPath ? (2000 / 6) : 2000;
      if (a.z < near || b.z < near || c.z < near) continue;
      const pa = this.project(a), pb = this.project(b), pc = this.project(c);
      if (!pa || !pb || !pc) continue;
      const area = (pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x);
      if (Math.abs(area) < 0.02) continue;
      const cull = options.cull !== undefined ? options.cull : !!this.flags[1];
      if (cull && (this.flags[3] ? area < 0 : area > 0)) continue;
      const nx = (a.nx + b.nx + c.nx) / 3, ny = (a.ny + b.ny + c.ny) / 3, nz = (a.nz + b.nz + c.nz) / 3;
      const shade = clamp(Math.round((0.30 + 0.70 * Math.abs(0.25 * nx - 0.35 * ny - 0.9 * nz)) * 31), 0, 31);
      const material = mode === 0 ? ((color & 15) << 1) : (color & 255);
      const face = { a: pa, b: pb, c: pc, depth: (a.z + b.z + c.z) / 3,
        mode, color: material, shade, pairedTexture: !!this.flags[4] };
      if (mode === 4 || mode === 5) this.rasterize(face);
      else queue.push(face);
    }
    queue.sort((left, right) => right.depth - left.depth);
    for (const face of queue) this.rasterize(face);
  }

  project(v) {
    const near = v.cameraPath ? (2000 / 6) : 2000;
    if (v.z < near) return null;
    const inverse = 1 / v.z;
    const scale = v.cameraPath ? (512 / 3) : 16;
    return {
      x: this.centerX + v.cx * scale * inverse,
      y: this.centerY + v.cy * scale * inverse,
      z: v.z, iz: inverse, u: v.u, v: v.v,
    };
  }

  rasterize(face) {
    const a = face.a, b = face.b, c = face.c;
    const minX = clamp(Math.floor(Math.min(a.x, b.x, c.x)), 0, W - 1);
    const maxX = clamp(Math.ceil(Math.max(a.x, b.x, c.x)), 0, W - 1);
    const minY = clamp(Math.floor(Math.min(a.y, b.y, c.y)), 0, H - 1);
    const maxY = clamp(Math.ceil(Math.max(a.y, b.y, c.y)), 0, H - 1);
    if (minX > maxX || minY > maxY) return;
    const denominator = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(denominator) < 1e-8) return;
    const inverseDenominator = 1 / denominator;
    const pixels = this.fb.pixels, texture = this.texture, table = this.flatTable;
    const textured = (face.mode === 2 || face.mode === 3 || face.mode === 4) && texture;
    const sampleTexture = (x, py) => {
      const px = x + 0.5;
      const w0 = ((b.y - c.y) * (px - c.x) + (c.x - b.x) * (py - c.y)) * inverseDenominator;
      const w1 = ((c.y - a.y) * (px - c.x) + (a.x - c.x) * (py - c.y)) * inverseDenominator;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) return -1;
      const u = Math.floor(w0 * a.u + w1 * b.u + w2 * c.u) >> 4;
      const v = Math.floor(w0 * a.v + w1 * b.v + w2 * c.v) >> 4;
      return texture[((v & 255) << 8) | (u & 255)];
    };
    for (let y = minY; y <= maxY; ++y) {
      const py = y + 0.5;
      if (textured && face.pairedTexture) {
        // FUN_03001708 aligns each scanline span to a halfword. A lone odd
        // left edge and lone even right edge are written with STRH
        // read/modify/write; aligned interior samples use STRB. The latter
        // are duplicated to both pixels by the GBA VRAM bus.
        let first = -1, last = -1;
        for (let x = minX; x <= maxX; ++x) {
          if (sampleTexture(x, py) >= 0) { first = x; break; }
        }
        if (first < 0) continue;
        for (let x = maxX; x >= first; --x) {
          if (sampleTexture(x, py) >= 0) { last = x; break; }
        }
        let x = first;
        if (x & 1) {
          pixels[y * W + x] = sampleTexture(x, py);
          ++x;
        }
        for (; x + 1 <= last; x += 2) {
          const color = sampleTexture(x, py);
          pixels[y * W + x] = color;
          pixels[y * W + x + 1] = color;
        }
        if (x <= last) pixels[y * W + x] = sampleTexture(x, py);
        continue;
      }
      let at = y * W + minX;
      for (let x = minX; x <= maxX; ++x, ++at) {
        const px = x + 0.5;
        const w0 = ((b.y - c.y) * (px - c.x) + (c.x - b.x) * (py - c.y)) * inverseDenominator;
        const w1 = ((c.y - a.y) * (px - c.x) + (a.x - c.x) * (py - c.y)) * inverseDenominator;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        if (!textured) {
          // When 0x03005280 points at a 32x256 .tab, flat polygons remap
          // the pixel already in the framebuffer through the material row.
          // This is how the rings/shards shade a copied background.
          pixels[at] = table && table.length >= 8192
            ? table[((face.color & 31) << 8) | pixels[at]]
            : face.color & 255;
          continue;
        }
        // The GBA triangle mapper is affine, including the characteristic
        // texture swim this produces on close geometry.
        const u = Math.floor(w0 * a.u + w1 * b.u + w2 * c.u) >> 4;
        const v = Math.floor(w0 * a.v + w1 * b.v + w2 * c.v) >> 4;
        pixels[at] = texture[((v & 255) << 8) | (u & 255)];
      }
    }
  }

  // 0x030024d0: sample the packed U/V map through the ROM's rotating affine
  // window. With a fade map the native loop issues one byte store for each
  // pair of Mode-4 pixels. GBA VRAM replicates an 8-bit write across its
  // 16-bit bus, so both bytes of that pixel pair receive the same value.
  drawTunnel(uMap, vMap, texture, fade, rotation, scale, offset = 0, additive = false) {
    const pixels = this.fb.pixels;
    const s = Math.trunc(Math.sin(angle(rotation)) * 256);
    const c = Math.trunc(Math.sin(angle(rotation + 0x1000)) * 256);
    const width = fade ? 120 : 240;
    let rowX = 0x8000 + scale * (c - s);
    let rowY = 0x8000 + scale * (c + s);
    const dXdx = Math.trunc((-2 * scale * c) / width);
    const dYdx = Math.trunc((-2 * scale * s) / width);
    const dXdy = Math.trunc((2 * scale * s) / H);
    const dYdy = Math.trunc((-2 * scale * c) / H);
    for (let y = 0; y < H; ++y) {
      let mapX = rowX, mapY = rowY;
      for (let x = 0; x < width; ++x, mapX += dXdx, mapY += dYdx) {
        const mapAt = ((mapY & 0xff00) | ((mapX & 0xff00) >>> 8)) >>> 0;
        const packedUV = uMap[mapAt] | (vMap[mapAt] << 8);
        let color = texture[(packedUV + offset) & 0xffff];
        if (fade) {
          color = additive
            ? Math.min(255, color + fade[mapAt])
            : Math.max(1, color - fade[y * 120 + x]);
        }
        const at = y * W + (fade ? x * 2 : x);
        pixels[at] = color;
        if (fade) pixels[at + 1] = color;
      }
      rowX += dXdy;
      rowY += dYdy;
    }
  }
}
