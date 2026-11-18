// Compiles a Structured Text AST into a tree of JS closures operating on a
// memory object. Performs static checks (undeclared vars, unknown FB pins,
// writes to inputs/constants) so the user gets errors with line numbers.
import { parse } from './st-parser.js';
import { StSyntaxError } from './st-lexer.js';
import { isFbType, fbDef, createFb, execFb } from './function-blocks.js';

const INT_TYPES = new Set(['SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT', 'ULINT', 'BYTE', 'WORD', 'DWORD', 'LWORD']);
const REAL_TYPES = new Set(['REAL', 'LREAL']);
export const SCALAR_TYPES = new Set(['BOOL', 'TIME', 'STRING', ...INT_TYPES, ...REAL_TYPES]);

const EXIT = 1;
const RETURN = 2;
const WATCHDOG_LIMIT = 250000;

export class PlcError extends Error {
  constructor(msg, line, col, kind = 'compile') {
    super(msg);
    this.line = line;
    this.col = col;
    this.kind = kind;
  }
}

export function defaultValue(type) {
  if (type === 'BOOL') return false;
  if (type === 'STRING') return '';
  return 0;
}

export function coerce(type, v) {
  if (type === 'BOOL') return !!v;
  if (INT_TYPES.has(type)) {
    const n = Math.trunc(Number(v) || 0);
    return n;
  }
  if (type === 'STRING') return String(v);
  if (REAL_TYPES.has(type) || type === 'TIME') {
    const n = Number(v);
    return isNaN(n) ? 0 : n;
  }
  return v;
}

function numType(t) {
  return INT_TYPES.has(t) ? 'INT' : REAL_TYPES.has(t) ? 'REAL' : t;
}

const BUILTINS = {
  ABS: { n: [1], f: (a) => Math.abs(a) },
  SQRT: { n: [1], f: (a) => Math.sqrt(a), t: 'REAL' },
  EXP: { n: [1], f: (a) => Math.exp(a), t: 'REAL' },
  LN: { n: [1], f: (a) => Math.log(a), t: 'REAL' },
  SIN: { n: [1], f: (a) => Math.sin(a), t: 'REAL' },
  COS: { n: [1], f: (a) => Math.cos(a), t: 'REAL' },
  TRUNC: { n: [1], f: (a) => Math.trunc(a), t: 'INT' },
  ROUND: { n: [1], f: (a) => Math.round(a), t: 'INT' },
  MIN: { n: [2, 99], f: (...a) => Math.min(...a) },
  MAX: { n: [2, 99], f: (...a) => Math.max(...a) },
  LIMIT: { n: [3], f: (mn, x, mx) => Math.max(mn, Math.min(mx, x)) },
  SEL: { n: [3], f: (g, a, b) => (g ? b : a) },
  MOVE: { n: [1], f: (a) => a },
};

function builtin(name) {
  const up = name.toUpperCase();
  if (BUILTINS[up]) return BUILTINS[up];
  // type conversions XXX_TO_YYY
  const m = /^([A-Z]+)_TO_([A-Z]+)$/.exec(up);
  if (m && (SCALAR_TYPES.has(m[2]))) {
    const to = m[2];
    return { n: [1], f: (a) => coerce(to, a), t: to };
  }
  return null;
}

/**
 * Compile source against an external symbol table.
 * @param {string} src
 * @param {Array<{name:string,type:string,dir:'input'|'output'}>} ioSymbols
 */
export function compileST(src, ioSymbols = []) {
  let ast;
  try {
    ast = parse(src);
  } catch (e) {
    if (e instanceof StSyntaxError) throw new PlcError(e.message, e.line, e.col, 'syntax');
    throw e;
  }
  const symbols = new Map(); // UPPER -> {name,type,dir,constant}
  for (const s of ioSymbols) symbols.set(s.name.toUpperCase(), { ...s, constant: false });
  for (const d of ast.decls) {
    const key = d.name.toUpperCase();
    const existing = symbols.get(key);
    if (existing && existing.dir) {
      // allow re-declaring IO with same type (e.g. VAR_INPUT Start : BOOL) – ignore
      if (existing.type !== d.type) {
        throw new PlcError(`'${d.name}' is an I/O point of type ${existing.type}, cannot redeclare as ${d.type}`, d.line, 1);
      }
      continue;
    }
    if (existing) throw new PlcError(`Duplicate declaration of '${d.name}'`, d.line, 1);
    if (!SCALAR_TYPES.has(d.type) && !isFbType(d.type)) {
      throw new PlcError(`Unknown type '${d.type}'`, d.line, 1);
    }
    symbols.set(key, { name: d.name, type: d.type, dir: null, constant: d.constant, decl: d });
  }

  // ---- expressions -------------------------------------------------------
  function sym(name, line, col) {
    const s = symbols.get(name.toUpperCase());
    if (!s) throw new PlcError(`Undeclared variable '${name}'`, line, col);
    return s;
  }

  function compileExpr(e) {
    switch (e.k) {
      case 'lit': {
        const v = e.v;
        return { f: () => v, t: e.type };
      }
      case 'var': {
        const s = sym(e.name, e.line, e.col);
        const key = s.name.toUpperCase();
        if (isFbType(s.type)) {
          if (!e.member) throw new PlcError(`'${e.name}' is a ${s.type}; use ${e.name}.Q (or another output)`, e.line, e.col);
          const mk = e.member.toUpperCase();
          const ft = fbDef(s.type).fields[mk];
          if (!ft) throw new PlcError(`${s.type} has no field '${e.member}'`, e.line, e.col);
          return { f: (m) => m[key][mk], t: ft };
        }
        if (e.member) throw new PlcError(`'${e.name}' has no members`, e.line, e.col);
        return { f: (m) => m[key], t: s.type };
      }
      case 'un': {
        const a = compileExpr(e.a);
        const af = a.f;
        if (e.op === 'NOT') {
          if (a.t === 'BOOL') return { f: (m) => !af(m), t: 'BOOL' };
          return { f: (m) => ~af(m), t: a.t };
        }
        return { f: (m) => -af(m), t: a.t };
      }
      case 'bin': {
        const a = compileExpr(e.a);
        const b = compileExpr(e.b);
        const af = a.f;
        const bf = b.f;
        const ta = numType(a.t);
        const tb = numType(b.t);
        const bothBool = a.t === 'BOOL' && b.t === 'BOOL';
        const arithT = ta === 'REAL' || tb === 'REAL' ? 'REAL' : ta === 'TIME' || tb === 'TIME' ? 'TIME' : 'INT';
        switch (e.op) {
          case 'AND': return bothBool ? { f: (m) => af(m) && bf(m), t: 'BOOL' } : { f: (m) => af(m) & bf(m), t: 'INT' };
          case 'OR': return bothBool ? { f: (m) => af(m) || bf(m), t: 'BOOL' } : { f: (m) => af(m) | bf(m), t: 'INT' };
          case 'XOR': return bothBool ? { f: (m) => af(m) !== bf(m), t: 'BOOL' } : { f: (m) => af(m) ^ bf(m), t: 'INT' };
          case '=': return { f: (m) => af(m) === bf(m) || (typeof af(m) === 'number' && Math.abs(af(m) - bf(m)) < 1e-12), t: 'BOOL' };
          case '<>': return { f: (m) => af(m) !== bf(m), t: 'BOOL' };
          case '<': return { f: (m) => af(m) < bf(m), t: 'BOOL' };
          case '>': return { f: (m) => af(m) > bf(m), t: 'BOOL' };
          case '<=': return { f: (m) => af(m) <= bf(m), t: 'BOOL' };
          case '>=': return { f: (m) => af(m) >= bf(m), t: 'BOOL' };
          case '+': return { f: (m) => af(m) + bf(m), t: arithT };
          case '-': return { f: (m) => af(m) - bf(m), t: arithT };
          case '*': return { f: (m) => af(m) * bf(m), t: arithT };
          case '/':
            if (arithT === 'INT') {
              return {
                f: (m) => {
                  const d = bf(m);
                  if (d === 0) throw new PlcError('Division by zero', e.line, 1, 'runtime');
                  return Math.trunc(af(m) / d);
                },
                t: 'INT',
              };
            }
            return { f: (m) => af(m) / bf(m), t: arithT };
          case 'MOD':
            return {
              f: (m) => {
                const d = bf(m);
                if (d === 0) throw new PlcError('Division by zero (MOD)', e.line, 1, 'runtime');
                return af(m) % d;
              },
              t: 'INT',
            };
          case '**': return { f: (m) => af(m) ** bf(m), t: 'REAL' };
        }
        throw new PlcError(`Unknown operator ${e.op}`, e.line, 1);
      }
      case 'fn': {
        const bi = builtin(e.name);
        if (!bi) {
          const s = symbols.get(e.name.toUpperCase());
          if (s && isFbType(s.type)) {
            throw new PlcError(`Function block '${e.name}' must be called as a statement: ${e.name}(...);`, e.line, e.col);
          }
          throw new PlcError(`Unknown function '${e.name}'`, e.line, e.col);
        }
        const [mn, mx = mn] = bi.n;
        if (e.args.length < mn || e.args.length > mx) {
          throw new PlcError(`${e.name.toUpperCase()} expects ${mn === mx ? mn : mn + '+'} argument(s)`, e.line, e.col);
        }
        const args = e.args.map(compileExpr);
        const fs = args.map((a) => a.f);
        const t = bi.t || args[args.length - 1].t;
        const fn = bi.f;
        if (fs.length === 1) { const f0 = fs[0]; return { f: (m) => fn(f0(m)), t }; }
        return { f: (m) => fn(...fs.map((f) => f(m))), t };
      }
    }
    throw new PlcError('Bad expression', e.line || 0, 1);
  }

  function compileTarget(tg) {
    const s = sym(tg.name, tg.line, tg.col);
    const key = s.name.toUpperCase();
    if (isFbType(s.type)) {
      if (!tg.member) throw new PlcError(`Cannot assign to function block '${tg.name}'`, tg.line, tg.col);
      const mk = tg.member.toUpperCase();
      const ft = fbDef(s.type).fields[mk];
      if (!ft) throw new PlcError(`${s.type} has no field '${tg.member}'`, tg.line, tg.col);
      return { set: (m, v) => { m[key][mk] = coerce(ft, v); }, t: ft };
    }
    if (tg.member) throw new PlcError(`'${tg.name}' has no members`, tg.line, tg.col);
    if (s.dir === 'input') throw new PlcError(`'${s.name}' is a physical input and is read-only`, tg.line, tg.col);
    if (s.constant) throw new PlcError(`'${s.name}' is a CONSTANT`, tg.line, tg.col);
    const t = s.type;
    return { set: (m, v) => { m[key] = coerce(t, v); }, t };
  }

  function compileBlock(stmts) {
    const fs = stmts.map(compileStmt);
    return (m, ctx) => {
      for (let i = 0; i < fs.length; i++) {
        const r = fs[i](m, ctx);
        if (r) return r;
      }
      return 0;
    };
  }

  function compileStmt(s) {
    switch (s.k) {
      case 'assign': {
        const tg = compileTarget(s.target);
        const ex = compileExpr(s.expr);
        const set = tg.set;
        const f = ex.f;
        const line = s.line;
        return (m, ctx) => {
          ctx.line = line;
          set(m, f(m));
          return 0;
        };
      }
      case 'call': {
        const sy = sym(s.name, s.line, s.col);
        if (!isFbType(sy.type)) throw new PlcError(`'${s.name}' is not a function block instance`, s.line, s.col);
        const def = fbDef(sy.type);
        const key = sy.name.toUpperCase();
        const ins = [];
        const outs = [];
        let pos = 0;
        for (const a of s.args) {
          let pin;
          if (a.name) pin = a.name.toUpperCase();
          else pin = def.inputs[pos++];
          if (!pin || !def.fields[pin]) throw new PlcError(`${sy.type} has no pin '${a.name || '#' + pos}'`, s.line, s.col);
          if (a.out) {
            const tg = compileTarget(a.out);
            outs.push({ pin, set: tg.set });
          } else {
            if (!def.inputs.includes(pin)) throw new PlcError(`'${pin}' is an output of ${sy.type}; use ${pin} => variable`, s.line, s.col);
            const ex = compileExpr(a.expr);
            const ft = def.fields[pin];
            ins.push({ pin, f: ex.f, t: ft });
          }
        }
        const line = s.line;
        return (m, ctx) => {
          ctx.line = line;
          const inst = m[key];
          for (let i = 0; i < ins.length; i++) inst[ins[i].pin] = coerce(ins[i].t, ins[i].f(m));
          execFb(inst, ctx.now);
          for (let i = 0; i < outs.length; i++) outs[i].set(m, inst[outs[i].pin]);
          return 0;
        };
      }
      case 'if': {
        const brs = s.branches.map((b) => ({ c: compileExpr(b.cond).f, body: compileBlock(b.body) }));
        const el = s.elseBody ? compileBlock(s.elseBody) : null;
        return (m, ctx) => {
          for (let i = 0; i < brs.length; i++) {
            if (brs[i].c(m)) return brs[i].body(m, ctx);
          }
          return el ? el(m, ctx) : 0;
        };
      }
      case 'case': {
        const sel = compileExpr(s.expr).f;
        const resolve = (lab) => {
          if (typeof lab === 'number') return lab;
          const sy = sym(lab.enumName, lab.line, 1);
          if (!sy.constant || !sy.decl || !sy.decl.init) {
            throw new PlcError(`CASE label '${lab.enumName}' must be a literal or CONSTANT`, lab.line, 1);
          }
          return compileExpr(sy.decl.init).f({});
        };
        const cases = s.cases.map((c) => ({
          labels: c.labels.map((l) => ({ lo: resolve(l.lo), hi: resolve(l.hi) })),
          body: compileBlock(c.body),
        }));
        const el = s.elseBody ? compileBlock(s.elseBody) : null;
        return (m, ctx) => {
          const v = sel(m);
          for (const c of cases) {
            for (const l of c.labels) if (v >= l.lo && v <= l.hi) return c.body(m, ctx);
          }
          return el ? el(m, ctx) : 0;
        };
      }
      case 'for': {
        const tg = compileTarget(s.v);
        const getv = compileExpr({ k: 'var', name: s.v.name, line: s.v.line, col: s.v.col }).f;
        const from = compileExpr(s.from).f;
        const to = compileExpr(s.to).f;
        const by = s.by ? compileExpr(s.by).f : () => 1;
        const body = compileBlock(s.body);
        const line = s.line;
        return (m, ctx) => {
          tg.set(m, from(m));
          const step = by(m);
          if (step === 0) throw new PlcError('FOR loop step is zero', line, 1, 'runtime');
          for (;;) {
            const i = getv(m);
            const end = to(m);
            if (step > 0 ? i > end : i < end) break;
            if (++ctx.steps > WATCHDOG_LIMIT) throw new PlcError('Watchdog: scan cycle took too long (endless loop?)', line, 1, 'runtime');
            const r = body(m, ctx);
            if (r === EXIT) break;
            if (r === RETURN) return RETURN;
            tg.set(m, getv(m) + step);
          }
          return 0;
        };
      }
      case 'while': {
        const c = compileExpr(s.cond).f;
        const body = compileBlock(s.body);
        const line = s.line;
        return (m, ctx) => {
          while (c(m)) {
            if (++ctx.steps > WATCHDOG_LIMIT) throw new PlcError('Watchdog: scan cycle took too long (endless loop?)', line, 1, 'runtime');
            const r = body(m, ctx);
            if (r === EXIT) break;
            if (r === RETURN) return RETURN;
          }
          return 0;
        };
      }
      case 'repeat': {
        const c = compileExpr(s.cond).f;
        const body = compileBlock(s.body);
        const line = s.line;
        return (m, ctx) => {
          do {
            if (++ctx.steps > WATCHDOG_LIMIT) throw new PlcError('Watchdog: scan cycle took too long (endless loop?)', line, 1, 'runtime');
            const r = body(m, ctx);
            if (r === EXIT) break;
            if (r === RETURN) return RETURN;
          } while (!c(m));
          return 0;
        };
      }
      case 'exit': return () => EXIT;
      case 'return': return () => RETURN;
    }
    throw new PlcError('Unknown statement', s.line || 0, 1);
  }

  const run = compileBlock(ast.body);

  // Build initial memory for declared (non-IO) variables
  function initMemory(mem) {
    for (const s of symbols.values()) {
      if (s.dir) continue;
      const key = s.name.toUpperCase();
      if (isFbType(s.type)) {
        const fb = createFb(s.type);
        mem[key] = fb;
      } else {
        let v = defaultValue(s.type);
        if (s.decl && s.decl.init) v = coerce(s.type, compileExpr(s.decl.init).f(mem));
        mem[key] = v;
      }
    }
  }

  return {
    ast,
    symbols,
    initMemory,
    run(mem, ctx) {
      ctx.steps = 0;
      run(mem, ctx);
    },
  };
}
