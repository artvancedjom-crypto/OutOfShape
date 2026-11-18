// Standard IEC 61131-3 function blocks. Each instance is a plain object of
// fields plus an exec(nowMs) method. Field names are upper-case.

const defs = {
  TON: {
    fields: { IN: 'BOOL', PT: 'TIME', Q: 'BOOL', ET: 'TIME' },
    inputs: ['IN', 'PT'],
    kind: 'timer',
    exec(s, now) {
      if (s.IN) {
        if (s._start == null) s._start = now;
        s.ET = Math.min(now - s._start, s.PT);
        s.Q = s.ET >= s.PT;
      } else {
        s._start = null;
        s.ET = 0;
        s.Q = false;
      }
    },
  },
  TOF: {
    fields: { IN: 'BOOL', PT: 'TIME', Q: 'BOOL', ET: 'TIME' },
    inputs: ['IN', 'PT'],
    kind: 'timer',
    exec(s, now) {
      if (s.IN) {
        s.Q = true;
        s.ET = 0;
        s._start = null;
      } else if (s.Q) {
        if (s._start == null) s._start = now;
        s.ET = Math.min(now - s._start, s.PT);
        if (s.ET >= s.PT) s.Q = false;
      }
    },
  },
  TP: {
    fields: { IN: 'BOOL', PT: 'TIME', Q: 'BOOL', ET: 'TIME' },
    inputs: ['IN', 'PT'],
    kind: 'timer',
    exec(s, now) {
      if (s.IN && !s._prev && !s.Q) {
        s._start = now;
        s.Q = true;
      }
      if (s.Q) {
        s.ET = Math.min(now - s._start, s.PT);
        if (s.ET >= s.PT) s.Q = false;
      } else if (!s.IN) {
        s.ET = 0;
      }
      s._prev = s.IN;
    },
  },
  CTU: {
    fields: { CU: 'BOOL', R: 'BOOL', PV: 'INT', Q: 'BOOL', CV: 'INT' },
    inputs: ['CU', 'R', 'PV'],
    kind: 'counter',
    exec(s) {
      if (s.R) s.CV = 0;
      else if (s.CU && !s._prev && s.CV < 32767) s.CV++;
      s._prev = s.CU;
      s.Q = s.CV >= s.PV;
    },
  },
  CTD: {
    fields: { CD: 'BOOL', LD: 'BOOL', PV: 'INT', Q: 'BOOL', CV: 'INT' },
    inputs: ['CD', 'LD', 'PV'],
    kind: 'counter',
    exec(s) {
      if (s.LD) s.CV = s.PV;
      else if (s.CD && !s._prev && s.CV > -32768) s.CV--;
      s._prev = s.CD;
      s.Q = s.CV <= 0;
    },
  },
  CTUD: {
    fields: { CU: 'BOOL', CD: 'BOOL', R: 'BOOL', LD: 'BOOL', PV: 'INT', QU: 'BOOL', QD: 'BOOL', CV: 'INT' },
    inputs: ['CU', 'CD', 'R', 'LD', 'PV'],
    kind: 'counter',
    exec(s) {
      if (s.R) s.CV = 0;
      else if (s.LD) s.CV = s.PV;
      else {
        if (s.CU && !s._pu) s.CV++;
        if (s.CD && !s._pd) s.CV--;
      }
      s._pu = s.CU;
      s._pd = s.CD;
      s.QU = s.CV >= s.PV;
      s.QD = s.CV <= 0;
    },
  },
  R_TRIG: {
    fields: { CLK: 'BOOL', Q: 'BOOL' },
    inputs: ['CLK'],
    kind: 'edge',
    exec(s) {
      s.Q = s.CLK && !s._prev;
      s._prev = s.CLK;
    },
  },
  F_TRIG: {
    fields: { CLK: 'BOOL', Q: 'BOOL' },
    inputs: ['CLK'],
    kind: 'edge',
    exec(s) {
      s.Q = !s.CLK && !!s._prev;
      s._prev = s.CLK;
    },
  },
  SR: {
    fields: { S1: 'BOOL', R: 'BOOL', Q1: 'BOOL' },
    inputs: ['S1', 'R'],
    kind: 'bistable',
    exec(s) {
      s.Q1 = s.S1 || (!s.R && s.Q1);
    },
  },
  RS: {
    fields: { S: 'BOOL', R1: 'BOOL', Q1: 'BOOL' },
    inputs: ['S', 'R1'],
    kind: 'bistable',
    exec(s) {
      s.Q1 = !s.R1 && (s.S || s.Q1);
    },
  },
};

export const FB_TYPES = Object.keys(defs);

export function isFbType(t) {
  return Object.prototype.hasOwnProperty.call(defs, t);
}

export function fbDef(t) {
  return defs[t];
}

export function createFb(type) {
  const d = defs[type];
  const s = { __fb: type };
  for (const [k, t] of Object.entries(d.fields)) s[k] = t === 'BOOL' ? false : 0;
  return s;
}

export function execFb(inst, now) {
  defs[inst.__fb].exec(inst, now);
}
