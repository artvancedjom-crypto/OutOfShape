// Ladder Diagram (LD) model + compiler to Structured Text.
//
// A program is a list of rungs. Each rung has parallel branches; each branch is
// a series chain of contacts. The rung's power flow drives one output element.
//
//   rung = { comment, branches: [[contact,...], ...], out }
//   contact = { type: 'NO' | 'NC' | 'P' | 'N', var: 'Start' | 'T1.Q' | 'T1' }
//   out = { type: 'COIL'|'NCOIL'|'SET'|'RESET'|'TON'|'TOF'|'TP'|'CTU'|'CTD', var, preset?, reset? }
import { isFbType } from './function-blocks.js';

export const CONTACT_TYPES = ['NO', 'NC', 'P', 'N'];
export const OUTPUT_TYPES = ['COIL', 'NCOIL', 'SET', 'RESET', 'TON', 'TOF', 'TP', 'CTU', 'CTD'];
const FB_OUT = { TON: 'TON', TOF: 'TOF', TP: 'TP', CTU: 'CTU', CTD: 'CTD' };

export function emptyLadder() {
  return { rungs: [newRung()] };
}

export function newRung() {
  return { comment: '', branches: [[{ type: 'NO', var: '' }]], out: { type: 'COIL', var: '' } };
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function fmtPreset(type, preset) {
  if (type === 'CTU' || type === 'CTD') return String(parseInt(preset, 10) || 0);
  if (preset == null || preset === '') return 'T#1s';
  const p = String(preset).trim();
  if (/^(T|TIME)#/i.test(p)) return p;
  if (/^\d+(\.\d+)?$/.test(p)) return `T#${p}ms`;
  if (/^\d+(\.\d+)?(ms|s|m|h)$/i.test(p)) return `T#${p}`;
  return p; // variable name
}

/**
 * @param {{rungs:any[]}} ladder
 * @param {Array<{name:string,type:string,dir:string}>} ioSymbols
 * @returns {{source:string, errors:Array<{rung:number,msg:string}>}}
 */
export function ladderToST(ladder, ioSymbols) {
  const io = new Map(ioSymbols.map((s) => [s.name.toUpperCase(), s]));
  const fbs = new Map(); // UPPER -> {name,type}
  const mem = new Map(); // UPPER -> name  (internal BOOL markers)
  const errors = [];
  let edgeN = 0;
  const edgeDecls = [];

  // first pass: FB instances
  ladder.rungs.forEach((r, i) => {
    const o = r.out;
    if (FB_OUT[o.type]) {
      if (!IDENT.test(o.var || '')) errors.push({ rung: i, msg: `Rung ${i + 1}: ${o.type} needs an instance name (e.g. T1)` });
      else {
        const k = o.var.toUpperCase();
        const prev = fbs.get(k);
        if (prev && prev.type !== o.type) errors.push({ rung: i, msg: `Rung ${i + 1}: '${o.var}' already used as ${prev.type}` });
        if (io.has(k)) errors.push({ rung: i, msg: `Rung ${i + 1}: '${o.var}' is an I/O point, choose another instance name` });
        fbs.set(k, { name: o.var, type: o.type });
      }
    }
  });

  const ref = (v, i) => {
    v = (v || '').trim();
    if (!v) { errors.push({ rung: i, msg: `Rung ${i + 1}: empty contact/coil address` }); return 'FALSE'; }
    const [base, member] = v.split('.');
    if (!IDENT.test(base) || (member !== undefined && !IDENT.test(member))) {
      errors.push({ rung: i, msg: `Rung ${i + 1}: invalid address '${v}'` });
      return 'FALSE';
    }
    const k = base.toUpperCase();
    if (fbs.has(k)) return member ? `${fbs.get(k).name}.${member.toUpperCase()}` : `${fbs.get(k).name}.Q`;
    if (member) { errors.push({ rung: i, msg: `Rung ${i + 1}: '${base}' is not a timer/counter` }); return 'FALSE'; }
    if (!io.has(k) && !mem.has(k)) mem.set(k, base);
    return io.has(k) ? io.get(k).name : mem.get(k);
  };

  const lines = [];
  ladder.rungs.forEach((r, i) => {
    lines.push(`(* Rung ${i + 1}${r.comment ? ': ' + r.comment.replace(/\*\)/g, '') : ''} *)`);
    const branchExprs = (r.branches.length ? r.branches : [[]]).map((br) => {
      if (!br.length) return 'TRUE';
      const parts = br.map((c) => {
        const a = ref(c.var, i);
        if (c.type === 'NC') return `NOT ${a}`;
        if (c.type === 'P' || c.type === 'N') {
          const inst = `_EDGE${++edgeN}`;
          edgeDecls.push(`  ${inst} : ${c.type === 'P' ? 'R_TRIG' : 'F_TRIG'};`);
          lines.push(`${inst}(CLK := ${a});`);
          return `${inst}.Q`;
        }
        return a;
      });
      return parts.length > 1 ? parts.join(' AND ') : parts[0];
    });
    const power = branchExprs.length > 1 ? branchExprs.map((b) => `(${b})`).join(' OR ') : branchExprs[0];
    const o = r.out;
    switch (o.type) {
      case 'COIL': lines.push(`${outRef(o.var, i)} := ${power};`); break;
      case 'NCOIL': lines.push(`${outRef(o.var, i)} := NOT (${power});`); break;
      case 'SET': lines.push(`IF ${power} THEN ${outRef(o.var, i)} := TRUE; END_IF;`); break;
      case 'RESET': lines.push(`IF ${power} THEN ${outRef(o.var, i)} := FALSE; END_IF;`); break;
      case 'TON': case 'TOF': case 'TP':
        if (IDENT.test(o.var || '')) lines.push(`${o.var}(IN := ${power}, PT := ${fmtPreset(o.type, o.preset)});`);
        break;
      case 'CTU':
        if (IDENT.test(o.var || '')) lines.push(`${o.var}(CU := ${power}, R := ${o.reset ? ref(o.reset, i) : 'FALSE'}, PV := ${fmtPreset('CTU', o.preset)});`);
        break;
      case 'CTD':
        if (IDENT.test(o.var || '')) lines.push(`${o.var}(CD := ${power}, LD := ${o.reset ? ref(o.reset, i) : 'FALSE'}, PV := ${fmtPreset('CTD', o.preset)});`);
        break;
      default: errors.push({ rung: i, msg: `Rung ${i + 1}: unknown output ${o.type}` });
    }
  });

  function outRef(v, i) {
    const a = ref(v, i);
    const k = (v || '').trim().toUpperCase();
    if (io.has(k) && io.get(k).dir === 'input') errors.push({ rung: i, msg: `Rung ${i + 1}: cannot drive input '${v}' with a coil` });
    if (a.includes('.')) errors.push({ rung: i, msg: `Rung ${i + 1}: cannot drive timer/counter output '${v}' with a coil` });
    return a;
  }

  const decl = [];
  if (fbs.size || mem.size || edgeDecls.length) {
    decl.push('VAR');
    for (const f of fbs.values()) decl.push(`  ${f.name} : ${f.type};`);
    for (const m of mem.values()) if (!isFbType(m)) decl.push(`  ${m} : BOOL;`);
    decl.push(...edgeDecls);
    decl.push('END_VAR');
  }
  return { source: ['(* Generated from Ladder Diagram *)', ...decl, '', ...lines].join('\n'), errors };
}
