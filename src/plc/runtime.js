// PLC runtime: owns the process image, runs the scan cycle
// (read inputs -> execute program -> write outputs) on simulated time.
import { compileST, PlcError, coerce, defaultValue } from './st-compiler.js';
import { ladderToST } from './ladder.js';
import { isFbType, fbDef } from './function-blocks.js';

export class PlcRuntime {
  /** @param {{inputs:any[], outputs:any[]}} io */
  constructor(io) {
    this.ioDef = io;
    this.symbols = [
      ...io.inputs.map((p) => ({ name: p.name, type: p.type || 'BOOL', dir: 'input' })),
      ...io.outputs.map((p) => ({ name: p.name, type: p.type || 'BOOL', dir: 'output' })),
    ];
    this.inputs = {}; // raw field values (from sim / user)
    this.forces = {}; // name -> forced value
    this.mem = {};
    this.program = null;
    this.running = false;
    this.error = null;
    this.now = 0;
    this.scanCount = 0;
    this.scanTimeMs = 50;
    this.lastExecUs = 0;
    for (const s of this.symbols) {
      if (s.dir === 'input') this.inputs[s.name] = defaultValue(s.type);
      this.mem[s.name.toUpperCase()] = defaultValue(s.type);
    }
    this.generatedST = '';
  }

  /** Compile & load a program. Returns {ok, errors[]} – does not start it. */
  load(lang, source) {
    let st = source;
    const errors = [];
    if (lang === 'LD') {
      const res = ladderToST(source, this.symbols);
      st = res.source;
      for (const e of res.errors) errors.push({ line: 0, col: 0, msg: e.msg, rung: e.rung });
      this.generatedST = st;
      if (errors.length) return { ok: false, errors };
    }
    try {
      const prog = compileST(st, this.symbols);
      this.program = prog;
      this.lang = lang;
      this.resetMemory();
      this.error = null;
      return { ok: true, errors: [], st };
    } catch (e) {
      if (e instanceof PlcError) return { ok: false, errors: [{ line: e.line, col: e.col, msg: e.message, kind: e.kind }], st };
      return { ok: false, errors: [{ line: 0, col: 0, msg: String(e && e.message ? e.message : e) }], st };
    }
  }

  resetMemory() {
    const mem = {};
    for (const s of this.symbols) {
      const k = s.name.toUpperCase();
      mem[k] = s.dir === 'input' ? this.effectiveInput(s.name) : defaultValue(s.type);
    }
    if (this.program) this.program.initMemory(mem);
    this.mem = mem;
    this.now = 0;
    this.scanCount = 0;
    this.error = null;
  }

  effectiveInput(name) {
    return Object.prototype.hasOwnProperty.call(this.forces, name) ? this.forces[name] : this.inputs[name];
  }

  setInput(name, v) {
    const s = this.symbols.find((x) => x.name === name);
    if (!s) return;
    this.inputs[name] = coerce(s.type, v);
  }

  force(name, v) {
    const s = this.symbols.find((x) => x.name === name);
    if (!s) return;
    if (v === undefined) delete this.forces[name];
    else this.forces[name] = coerce(s.type, v);
  }

  getOutput(name) {
    const v = this.mem[name.toUpperCase()];
    if (Object.prototype.hasOwnProperty.call(this.forces, name)) return this.forces[name];
    return v;
  }

  get(name) {
    return this.mem[name.toUpperCase()];
  }

  /** Execute one scan cycle that advances simulated time by dtMs. */
  scan(dtMs) {
    this.now += dtMs;
    // 1. read inputs into process image
    for (const s of this.symbols) {
      if (s.dir === 'input') this.mem[s.name.toUpperCase()] = this.effectiveInput(s.name);
    }
    if (!this.program || !this.running || this.error) return;
    const t0 = performance.now();
    const ctx = { now: this.now, steps: 0, line: 0 };
    try {
      this.program.run(this.mem, ctx);
    } catch (e) {
      this.error = { line: e.line || ctx.line, msg: e.message, kind: 'runtime' };
      this.running = false;
    }
    // forced outputs override program writes
    for (const s of this.symbols) {
      if (s.dir === 'output' && Object.prototype.hasOwnProperty.call(this.forces, s.name)) {
        this.mem[s.name.toUpperCase()] = this.forces[s.name];
      }
    }
    this.lastExecUs = (performance.now() - t0) * 1000;
    this.scanCount++;
  }

  /** Variables declared by the program (memory, timers, counters...). */
  internals() {
    if (!this.program) return [];
    const out = [];
    for (const s of this.program.symbols.values()) {
      if (s.dir) continue;
      const v = this.mem[s.name.toUpperCase()];
      if (isFbType(s.type)) out.push({ name: s.name, type: s.type, fb: v, kind: fbDef(s.type).kind });
      else out.push({ name: s.name, type: s.type, value: v, constant: s.constant });
    }
    return out;
  }
}
