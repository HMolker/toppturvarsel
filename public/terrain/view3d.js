/**
 * The terrain in 3D: the elevation grid as a WebGL mesh, draped with a
 * picture of the map (topo, the chosen overlays and the route, painted into
 * one canvas by the caller). Drag to turn, wheel or pinch to move closer,
 * a slider to exaggerate the heights. No library; WebGL 1.
 */

const VS = `
attribute vec3 aPos; attribute vec3 aNrm; attribute vec2 aUv;
uniform mat4 uMvp; uniform float uExag;
varying vec2 vUv; varying vec3 vNrm;
void main() {
  vUv = aUv;
  vNrm = normalize(vec3(aNrm.xy, aNrm.z / max(uExag, 0.01)));
  gl_Position = uMvp * vec4(aPos.xy, aPos.z * uExag, 1.0);
}`;
const FS = `
precision mediump float;
uniform sampler2D uTex; uniform vec3 uSun;
varying vec2 vUv; varying vec3 vNrm;
void main() {
  vec3 c = texture2D(uTex, vUv).rgb;
  float l = max(dot(normalize(vNrm), normalize(uSun)), 0.0);
  gl_FragColor = vec4(c * (0.45 + 0.65 * l), 1.0);
}`;

function mat4Mul(a, b) {
  const o = new Float32Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
    o[i * 4 + j] = s;
  }
  return o;
}
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}
function lookAt(eye, at, up) {
  const z = norm(sub(eye, at)), x = norm(cross(up, z)), y = cross(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

/** Vertices, normals, texture coordinates and triangles for a grid. */
export function buildMesh(grid) {
  const { nx, ny, ele, cellM } = grid;
  let lo = Infinity;
  for (const v of ele) if (Number.isFinite(v) && v < lo) lo = v;
  if (!Number.isFinite(lo)) lo = 0;
  const z = (i, j) => { const v = ele[j * nx + i]; return Number.isFinite(v) ? v : lo; };
  const pos = new Float32Array(nx * ny * 3), nrm = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2);
  let hi = -Infinity;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const h = z(i, j) - lo;
      if (h > hi) hi = h;
      pos.set([(i - (nx - 1) / 2) * cellM, ((ny - 1) / 2 - j) * cellM, h], k * 3);
      const dzdx = (z(Math.min(nx - 1, i + 1), j) - z(Math.max(0, i - 1), j)) / (((Math.min(nx - 1, i + 1) - Math.max(0, i - 1)) || 1) * cellM);
      const dzdy = (z(i, Math.max(0, j - 1)) - z(i, Math.min(ny - 1, j + 1))) / (((Math.min(ny - 1, j + 1) - Math.max(0, j - 1)) || 1) * cellM);
      const n = norm([-dzdx, -dzdy, 1]);
      nrm.set(n, k * 3);
      uv.set([i / (nx - 1), j / (ny - 1)], k * 2);
    }
  }
  const idx = new Uint16Array((nx - 1) * (ny - 1) * 6);
  let p = 0;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx.set([a, c, b, b, c, d], p);
      p += 6;
    }
  }
  return { pos, nrm, uv, idx, span: Math.max(nx, ny) * cellM, relief: hi, base: lo };
}

export class Terrain3D {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', { antialias: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL is not available in this browser');
    this.gl = gl;
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    this.prog = prog;
    this.loc = {
      aPos: gl.getAttribLocation(prog, 'aPos'), aNrm: gl.getAttribLocation(prog, 'aNrm'), aUv: gl.getAttribLocation(prog, 'aUv'),
      uMvp: gl.getUniformLocation(prog, 'uMvp'), uExag: gl.getUniformLocation(prog, 'uExag'),
      uTex: gl.getUniformLocation(prog, 'uTex'), uSun: gl.getUniformLocation(prog, 'uSun'),
    };
    this.yaw = -0.35;
    this.pitch = 0.62;
    this.distK = 0.85;
    this.exag = 1.3;
    this.bindInput();
  }

  setScene(grid, textureCanvas) {
    const gl = this.gl;
    const m = buildMesh(grid);
    this.mesh = m;
    const buf = (data, target = gl.ARRAY_BUFFER) => {
      const b = gl.createBuffer();
      gl.bindBuffer(target, b);
      gl.bufferData(target, data, gl.STATIC_DRAW);
      return b;
    };
    this.bufs = { pos: buf(m.pos), nrm: buf(m.nrm), uv: buf(m.uv), idx: buf(m.idx, gl.ELEMENT_ARRAY_BUFFER), count: m.idx.length };
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, textureCanvas);
    // Not a power of two: no mipmaps, clamp at the edges.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.tex = tex;
    this.draw();
  }

  draw() {
    const gl = this.gl, c = this.canvas;
    if (!this.mesh) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    gl.viewport(0, 0, W, H);
    const bg = getComputedStyle(c).getPropertyValue('--sky').trim() || '#e9ecef';
    const rgb = bg.match(/\w\w/g)?.map((h) => parseInt(h, 16) / 255) ?? [0.9, 0.9, 0.9];
    gl.clearColor(rgb[0], rgb[1], rgb[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);

    const { span, relief } = this.mesh;
    const d = span * this.distK;
    const target = [0, 0, relief * this.exag * 0.35];
    const eye = [
      target[0] + d * Math.cos(this.pitch) * Math.sin(this.yaw),
      target[1] - d * Math.cos(this.pitch) * Math.cos(this.yaw),
      target[2] + d * Math.sin(this.pitch),
    ];
    const proj = perspective(0.75, W / H, span * 0.02, span * 6);
    const view = lookAt(eye, target, [0, 0, 1]);
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.loc.uMvp, false, mat4Mul(proj, view));
    gl.uniform1f(this.loc.uExag, this.exag);
    gl.uniform3fv(this.loc.uSun, norm([-0.5, 0.6, 0.8])); // from the north-west, as on a relief map
    const attr = (loc, b, n) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, n, gl.FLOAT, false, 0, 0);
    };
    attr(this.loc.aPos, this.bufs.pos, 3);
    attr(this.loc.aNrm, this.bufs.nrm, 3);
    attr(this.loc.aUv, this.bufs.uv, 2);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.loc.uTex, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bufs.idx);
    gl.drawElements(gl.TRIANGLES, this.bufs.count, gl.UNSIGNED_SHORT, 0);
  }

  bindInput() {
    const c = this.canvas;
    const pts = new Map();
    let last = null, pinch = null;
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      last = [e.clientX, e.clientY];
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), k: this.distK };
      }
    });
    c.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (pinch && pts.size === 2) {
        const [a, b] = [...pts.values()];
        this.distK = Math.max(0.25, Math.min(3, pinch.k * pinch.d / Math.hypot(a[0] - b[0], a[1] - b[1])));
      } else if (last) {
        this.yaw += (e.clientX - last[0]) * 0.008;
        this.pitch = Math.max(0.12, Math.min(1.45, this.pitch + (e.clientY - last[1]) * 0.006));
        last = [e.clientX, e.clientY];
      }
      this.draw();
    });
    const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; last = pts.size ? [...pts.values()][0] : null; };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.distK = Math.max(0.25, Math.min(3, this.distK * Math.exp(e.deltaY * 0.001)));
      this.draw();
    }, { passive: false });
  }
}
