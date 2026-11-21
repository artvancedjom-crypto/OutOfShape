// Flow animation: particles along wires and through parts.
// All particles are drawn in ONE draw call as GL point sprites (positions are
// computed on the CPU, a few thousand floats per frame). A 2D-canvas fallback
// is used when WebGL is unavailable. No DOM element per particle.
import { U } from './parts.js';

const VS = `
attribute vec2 a_pos; attribute vec4 a_color; attribute float a_size;
uniform vec2 u_res; varying vec4 v_color;
void main() {
  vec2 c = a_pos / u_res * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
  gl_PointSize = a_size;
  v_color = a_color;
}`;
const FS = `
precision mediump float; varying vec4 v_color;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = smoothstep(1.0, 0.55, d);
  gl_FragColor = vec4(v_color.rgb * v_color.a * a, v_color.a * a);
}`;

export const FLOW_DEFAULTS = {
  on: true,
  electron: false, // false = conventional current (+ → −), true = electron flow
  sensitivity: 7, // currents below 10^-sensitivity A show nothing (7 = 100 nA)
  speed: 1,
  potential: false, // colour wires by voltage
  power: false, // heat tint by dissipated power
};
const STRIDE = 7; // x, y, r, g, b, a, size
const MAX = 24000;

/**
 * Logarithmic mapping of current to a 0..1 level, so µA and A are both visible:
 * level 0 at the threshold, 1 at 10 A.
 */
export function flowLevel(i, sensitivity) {
  const a = Math.abs(i);
  const min = 10 ** -sensitivity;
  if (a < min) return -1;
  return Math.min(1, Math.log10(a / min) / (1 + sensitivity));
}

export class FlowRenderer {
  constructor(host) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ce-flow';
    host.append(this.canvas);
    this.data = new Float32Array(MAX * STRIDE);
    this.count = 0;
    this.webgl = false;
    const gl = this.canvas.getContext('webgl', { premultipliedAlpha: true, antialias: false, alpha: true });
    if (gl) {
      try {
        const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
        const prog = gl.createProgram();
        gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
        gl.useProgram(prog);
        this.gl = gl;
        this.loc = { pos: gl.getAttribLocation(prog, 'a_pos'), color: gl.getAttribLocation(prog, 'a_color'), size: gl.getAttribLocation(prog, 'a_size'), res: gl.getUniformLocation(prog, 'u_res') };
        this.buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
        const B = Float32Array.BYTES_PER_ELEMENT;
        gl.enableVertexAttribArray(this.loc.pos);
        gl.vertexAttribPointer(this.loc.pos, 2, gl.FLOAT, false, STRIDE * B, 0);
        gl.enableVertexAttribArray(this.loc.color);
        gl.vertexAttribPointer(this.loc.color, 4, gl.FLOAT, false, STRIDE * B, 2 * B);
        gl.enableVertexAttribArray(this.loc.size);
        gl.vertexAttribPointer(this.loc.size, 1, gl.FLOAT, false, STRIDE * B, 6 * B);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        this.webgl = true;
      } catch (e) {
        console.warn('Flow animation falls back to 2D canvas:', e.message);
      }
    }
    if (!this.webgl) this.ctx2d = this.canvas.getContext('2d');
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    return dpr;
  }

  /**
   * @param {Array<{a:any,b:any,len:number,i:number,phase:number}>} items edges (a,b = {x,y}) and part paths (a,b = [x,y])
   * @param {{pan:number[], zoom:number}} view
   */
  draw(items, view, dt, opts) {
    const dpr = this.resize();
    const W = this.canvas.width;
    const H = this.canvas.height;
    const data = this.data;
    let n = 0;
    if (opts.on) {
      const scale = U * view.zoom * dpr;
      const ox = view.pan[0] * dpr;
      const oy = view.pan[1] * dpr;
      const dir = opts.electron ? -1 : 1;
      const col = opts.electron ? [0.25, 0.75, 1.0] : [1.0, 0.72, 0.1];
      const size = Math.max(5, Math.min(13, 7 * Math.sqrt(view.zoom))) * dpr;
      for (let k = 0; k < items.length && n < MAX - 64; k++) {
        const it = items[k];
        const level = flowLevel(it.i, opts.sensitivity);
        if (level < 0 || it.len < 1e-6) continue;
        const ax = it.a.x ?? it.a[0];
        const ay = it.a.y ?? it.a[1];
        const bx = it.b.x ?? it.b[0];
        const by = it.b.y ?? it.b[1];
        // cull what is off screen
        const sx1 = ax * scale + ox; const sy1 = ay * scale + oy; const sx2 = bx * scale + ox; const sy2 = by * scale + oy;
        if ((sx1 < -20 && sx2 < -20) || (sx1 > W + 20 && sx2 > W + 20) || (sy1 < -20 && sy2 < -20) || (sy1 > H + 20 && sy2 > H + 20)) continue;
        const spacing = 2.0 - 1.55 * level; // grid units between particles: denser with more current
        const speed = (0.7 + 6.3 * level) * opts.speed; // grid units per second: faster with more current
        it.phase = (it.phase + Math.sign(it.i) * dir * speed * dt) % spacing;
        if (it.phase < 0) it.phase += spacing;
        const alpha = 0.55 + 0.45 * level;
        for (let d = it.phase; d < it.len && n < MAX; d += spacing) {
          const t = d / it.len;
          const o = n * STRIDE;
          data[o] = sx1 + (sx2 - sx1) * t;
          data[o + 1] = sy1 + (sy2 - sy1) * t;
          data[o + 2] = col[0]; data[o + 3] = col[1]; data[o + 4] = col[2]; data[o + 5] = alpha;
          data[o + 6] = size;
          n++;
        }
      }
    }
    this.count = n;
    if (this.webgl) {
      const gl = this.gl;
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!n) return;
      gl.uniform2f(this.loc.res, W, H);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, n * STRIDE), gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.POINTS, 0, n);
    } else if (this.ctx2d) {
      const g = this.ctx2d;
      g.clearRect(0, 0, W, H);
      if (!n) return;
      g.fillStyle = opts.electron ? 'rgba(64,190,255,0.9)' : 'rgba(255,184,26,0.9)';
      g.beginPath();
      for (let k = 0; k < n; k++) { const o = k * STRIDE; const r = data[o + 6] / 2.6; g.moveTo(data[o] + r, data[o + 1]); g.arc(data[o], data[o + 1], r, 0, 6.283); }
      g.fill();
    }
  }

  destroy() {
    this.canvas.remove();
  }
}
