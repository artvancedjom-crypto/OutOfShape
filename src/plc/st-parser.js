// Recursive-descent parser for an IEC 61131-3 Structured Text subset.
import { tokenize, StSyntaxError } from './st-lexer.js';

const BIN_PREC = [
  ['OR'],
  ['XOR'],
  ['AND'],
  ['=', '<>'],
  ['<', '>', '<=', '>='],
  ['+', '-'],
  ['*', '/', 'MOD'],
  ['**'],
];

export function parse(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = (o = 0) => toks[p + o];
  const next = () => toks[p++];
  const is = (t, v) => {
    const k = toks[p];
    return k.t === t && (v === undefined || k.v === v);
  };
  const isKw = (v) => is('kw', v);
  const isOp = (v) => is('op', v);
  const fail = (msg, tok = toks[p]) => {
    throw new StSyntaxError(msg, tok.line, tok.col);
  };
  const describe = (tok) => (tok.t === 'eof' ? 'end of program' : `'${tok.v}'`);
  const expectKw = (v) => {
    if (!isKw(v)) fail(`Expected ${v} but found ${describe(peek())}`);
    return next();
  };
  const expectOp = (v) => {
    if (!isOp(v)) fail(`Expected '${v}' but found ${describe(peek())}`);
    return next();
  };
  const expectId = () => {
    if (!is('id')) fail(`Expected identifier but found ${describe(peek())}`);
    return next();
  };

  const program = { name: 'Main', decls: [], body: [] };
  if (isKw('PROGRAM')) {
    next();
    program.name = expectId().v;
  }

  const VAR_SECTIONS = ['VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_GLOBAL', 'VAR_TEMP'];
  while (VAR_SECTIONS.some((s) => isKw(s))) {
    const section = next().v;
    let constant = false;
    while (isKw('CONSTANT') || isKw('RETAIN')) {
      if (next().v === 'CONSTANT') constant = true;
    }
    while (!isKw('END_VAR')) {
      if (is('eof')) fail('Missing END_VAR');
      const names = [expectId()];
      while (isOp(',')) {
        next();
        names.push(expectId());
      }
      let address = null;
      if (isKw('AT')) {
        next();
        // accept %IX0.0 style addresses loosely: skip until ':'
        let s = '';
        while (!isOp(':') && !is('eof')) s += String(next().v);
        address = s;
      }
      expectOp(':');
      const typeTok = expectId();
      let type = typeTok.v.toUpperCase();
      // STRING[20]
      if (isOp('[')) {
        while (!isOp(']') && !is('eof')) next();
        expectOp(']');
      }
      let init = null;
      if (isOp(':=')) {
        next();
        init = parseExpr();
      }
      expectOp(';');
      for (const n of names) {
        program.decls.push({ name: n.v, type, init, section, constant, address, line: n.line });
      }
    }
    expectKw('END_VAR');
  }

  program.body = parseStatements(['END_PROGRAM', 'eof']);
  if (isKw('END_PROGRAM')) next();
  if (!is('eof')) fail(`Unexpected ${describe(peek())} after END_PROGRAM`);
  return program;

  function atEnd(terms) {
    const k = peek();
    if (k.t === 'eof') return true;
    return k.t === 'kw' && terms.includes(k.v);
  }

  function parseStatements(terms) {
    const out = [];
    while (!atEnd(terms)) {
      // CASE labels terminate statement lists inside CASE
      if (terms.includes('CASE_LABEL') && looksLikeCaseLabel()) break;
      const s = parseStatement();
      if (s) out.push(s);
    }
    return out;
  }

  function looksLikeCaseLabel() {
    // a case label is: literal [.. literal] {, ...} :   (not := )
    let k = p;
    const lit = () => {
      if (toks[k].t === 'op' && toks[k].v === '-') k++;
      if (toks[k].t === 'num' || toks[k].t === 'id') { k++; return true; }
      return false;
    };
    if (!lit()) return false;
    for (;;) {
      if (toks[k].t === 'op' && toks[k].v === '..') { k++; if (!lit()) return false; }
      if (toks[k].t === 'op' && toks[k].v === ',') { k++; if (!lit()) return false; continue; }
      break;
    }
    return toks[k].t === 'op' && toks[k].v === ':';
  }

  function parseStatement() {
    const tok = peek();
    if (isOp(';')) { next(); return null; }
    if (tok.t === 'kw') {
      switch (tok.v) {
        case 'IF': return parseIf();
        case 'CASE': return parseCase();
        case 'FOR': return parseFor();
        case 'WHILE': {
          next();
          const cond = parseExpr();
          expectKw('DO');
          const body = parseStatements(['END_WHILE']);
          expectKw('END_WHILE');
          optSemi();
          return { k: 'while', cond, body, line: tok.line };
        }
        case 'REPEAT': {
          next();
          const body = parseStatements(['UNTIL']);
          expectKw('UNTIL');
          const cond = parseExpr();
          expectKw('END_REPEAT');
          optSemi();
          return { k: 'repeat', cond, body, line: tok.line };
        }
        case 'EXIT': next(); optSemi(); return { k: 'exit', line: tok.line };
        case 'RETURN': next(); optSemi(); return { k: 'return', line: tok.line };
        default: fail(`Unexpected keyword ${tok.v}`);
      }
    }
    if (tok.t === 'id') {
      const name = next();
      let member = null;
      if (isOp('.')) {
        next();
        member = expectId().v;
      }
      if (isOp(':=')) {
        next();
        const expr = parseExpr();
        expectOp(';');
        return { k: 'assign', target: { name: name.v, member, line: name.line, col: name.col }, expr, line: name.line };
      }
      if (isOp('(') && !member) {
        next();
        const args = [];
        while (!isOp(')')) {
          if (is('id') && peek(1).t === 'op' && (peek(1).v === ':=' || peek(1).v === '=>')) {
            const an = next().v;
            const op = next().v;
            if (op === ':=') args.push({ name: an, expr: parseExpr() });
            else {
              const tn = expectId();
              let tm = null;
              if (isOp('.')) { next(); tm = expectId().v; }
              args.push({ name: an, out: { name: tn.v, member: tm, line: tn.line, col: tn.col } });
            }
          } else {
            args.push({ name: null, expr: parseExpr() });
          }
          if (isOp(',')) next();
          else if (!isOp(')')) fail(`Expected ',' or ')' in call but found ${describe(peek())}`);
        }
        expectOp(')');
        expectOp(';');
        return { k: 'call', name: name.v, args, line: name.line, col: name.col };
      }
      fail(`Expected ':=' or '(' after '${name.v}${member ? '.' + member : ''}'`);
    }
    fail(`Unexpected ${describe(tok)}`);
  }

  function optSemi() {
    if (isOp(';')) next();
  }

  function parseIf() {
    const tok = expectKw('IF');
    const branches = [];
    const cond = parseExpr();
    expectKw('THEN');
    branches.push({ cond, body: parseStatements(['ELSIF', 'ELSE', 'END_IF']) });
    let elseBody = null;
    while (isKw('ELSIF')) {
      next();
      const c = parseExpr();
      expectKw('THEN');
      branches.push({ cond: c, body: parseStatements(['ELSIF', 'ELSE', 'END_IF']) });
    }
    if (isKw('ELSE')) {
      next();
      elseBody = parseStatements(['END_IF']);
    }
    expectKw('END_IF');
    optSemi();
    return { k: 'if', branches, elseBody, line: tok.line };
  }

  function parseCaseLiteral() {
    let neg = false;
    if (isOp('-')) { next(); neg = true; }
    const t = next();
    if (t.t === 'num') return neg ? -t.v : t.v;
    if (t.t === 'id') return { enumName: t.v, line: t.line };
    fail('Expected case label', t);
  }

  function parseCase() {
    const tok = expectKw('CASE');
    const expr = parseExpr();
    expectKw('OF');
    const cases = [];
    let elseBody = null;
    while (!isKw('END_CASE')) {
      if (isKw('ELSE')) {
        next();
        if (isOp(':')) next();
        elseBody = parseStatements(['END_CASE']);
        break;
      }
      if (is('eof')) fail('Missing END_CASE');
      const labels = [];
      for (;;) {
        const lo = parseCaseLiteral();
        let hi = lo;
        if (isOp('..')) { next(); hi = parseCaseLiteral(); }
        labels.push({ lo, hi });
        if (isOp(',')) { next(); continue; }
        break;
      }
      expectOp(':');
      const body = parseStatements(['END_CASE', 'ELSE', 'CASE_LABEL']);
      cases.push({ labels, body });
    }
    expectKw('END_CASE');
    optSemi();
    return { k: 'case', expr, cases, elseBody, line: tok.line };
  }

  function parseFor() {
    const tok = expectKw('FOR');
    const v = expectId();
    expectOp(':=');
    const from = parseExpr();
    expectKw('TO');
    const to = parseExpr();
    let by = null;
    if (isKw('BY')) { next(); by = parseExpr(); }
    expectKw('DO');
    const body = parseStatements(['END_FOR']);
    expectKw('END_FOR');
    optSemi();
    return { k: 'for', v: { name: v.v, line: v.line, col: v.col }, from, to, by, body, line: tok.line };
  }

  function parseExpr(level = 0) {
    if (level >= BIN_PREC.length) return parseUnary();
    let a = parseExpr(level + 1);
    for (;;) {
      const k = peek();
      const op = (k.t === 'op' || k.t === 'kw') ? k.v : null;
      if (op && BIN_PREC[level].includes(op)) {
        next();
        const b = parseExpr(level + 1);
        a = { k: 'bin', op, a, b, line: k.line };
      } else break;
    }
    return a;
  }

  function parseUnary() {
    if (isKw('NOT')) {
      const t = next();
      return { k: 'un', op: 'NOT', a: parseUnary(), line: t.line };
    }
    if (isOp('-')) {
      const t = next();
      return { k: 'un', op: '-', a: parseUnary(), line: t.line };
    }
    if (isOp('+')) { next(); return parseUnary(); }
    return parsePrimary();
  }

  function parsePrimary() {
    const t = peek();
    if (t.t === 'num') { next(); return { k: 'lit', v: t.v, type: t.real ? 'REAL' : 'INT' }; }
    if (t.t === 'time') { next(); return { k: 'lit', v: t.v, type: 'TIME' }; }
    if (t.t === 'str') { next(); return { k: 'lit', v: t.v, type: 'STRING' }; }
    if (isKw('TRUE')) { next(); return { k: 'lit', v: true, type: 'BOOL' }; }
    if (isKw('FALSE')) { next(); return { k: 'lit', v: false, type: 'BOOL' }; }
    if (isOp('(')) {
      next();
      const e = parseExpr();
      expectOp(')');
      return e;
    }
    if (t.t === 'id') {
      next();
      if (isOp('(')) {
        next();
        const args = [];
        while (!isOp(')')) {
          // allow named args in functions (IN:=x) – value only
          if (is('id') && peek(1).t === 'op' && peek(1).v === ':=') { next(); next(); }
          args.push(parseExpr());
          if (isOp(',')) next();
          else if (!isOp(')')) fail(`Expected ',' or ')' but found ${describe(peek())}`);
        }
        expectOp(')');
        return { k: 'fn', name: t.v, args, line: t.line, col: t.col };
      }
      let member = null;
      if (isOp('.')) {
        next();
        member = expectId().v;
      }
      return { k: 'var', name: t.v, member, line: t.line, col: t.col };
    }
    fail(`Unexpected ${describe(t)} in expression`);
  }
}
