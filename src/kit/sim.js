// Process simulation for a kit scene: workpieces on conveyors and roads, cylinders,
// gates, liquids in tanks and pipes, and all sensors. Pure logic (no 3D, no DOM):
// it reads PLC outputs and writes PLC inputs through the `io` object it is given.
import { KIT, DIRS, RAW, sizeOf, heightOf } from './elements.js';

const overlap = (a, b) => a.x1 < b.x2 && a.x2 > b.x1 && a.z1 < b.z2 && a.z2 > b.z1;
const inside = (r, x, z) => x >= r.x1 && x <= r.x2 && z >= r.z1 && z <= r.z2;
let itemSeq = 0;

export function footprint(el) {
  const [w, d] = sizeOf(el);
  const odd = (el.rot || 0) % 2 === 1;
  const hw = (odd ? d : w) / 2;
  const hd = (odd ? w : d) / 2;
  return { x1: el.x - hw, z1: el.z - hd, x2: el.x + hw, z2: el.z + hd };
}

export function itemRect(it, grow = 0) {
  const alongX = Math.abs(it.hx) >= Math.abs(it.hz);
  const hw = (alongX ? it.len : it.wid) / 2 + grow;
  const hd = (alongX ? it.wid : it.len) / 2 + grow;
  return { x1: it.x - hw, z1: it.z - hd, x2: it.x + hw, z2: it.z + hd };
}

export class KitSim {
  /**
   * @param {{elements:any[]}} doc
   * @param {{out:(tag:string)=>any, set:(tag:string,v:any)=>void}} io
   * @param {KitSim} [prev] previous simulation: element states and workpieces are carried over after an edit
   */
  constructor(doc, io, prev = null) {
    this.doc = doc;
    this.io = io;
    this.time = prev ? prev.time : 0;
    this.items = prev ? prev.items : [];
    this.crashes = prev ? prev.crashes : 0;
    this.st = {};
    this.els = doc.elements.filter((el) => KIT[el.type]);
    for (const el of this.els) {
      const old = prev && prev.st[el.id];
      this.st[el.id] = old && old.__type === el.type ? old : { ...KIT[el.type].init(el), __type: el.type };
    }
    this.carriers = [];
    this.blockers = [];
    this.pushed = [];
    this._api();
  }

  reset() {
    this.items = [];
    this.crashes = 0;
    this.time = 0;
    for (const el of this.els) this.st[el.id] = { ...KIT[el.type].init(el), __type: el.type };
  }

  _api() {
    const sim = this;
    const fwd = (el) => DIRS[(el.rot || 0) % 4];
    const right = (el) => DIRS[((el.rot || 0) + 1) % 4];
    const box = (cx, cz, along, across, f) => {
      const hw = (f[0] !== 0 ? along : across) / 2;
      const hd = (f[0] !== 0 ? across : along) / 2;
      return { x1: cx - hw, z1: cz - hd, x2: cx + hw, z2: cz + hd };
    };
    this.W = {
      fwd,
      rect: footprint,
      /** rectangle in front of the element: starts `from` beyond its front edge, `len` long, `width` wide */
      front(el, from, len, width) {
        const f = fwd(el);
        const [w] = sizeOf(el);
        const c = w / 2 + from + len / 2;
        return box(el.x + f[0] * c, el.z + f[1] * c, len, width, f);
      },
      /** rectangle to the right of the element (looking forward) */
      side(el, from, len, width) {
        const r = right(el);
        const d = sizeOf(el)[1];
        const c = d / 2 + from + len / 2;
        return box(el.x + r[0] * c, el.z + r[1] * c, len, width, r);
      },
      out(el, key) {
        const p = el.io && el.io[key];
        if (!p || el.fault === 'break') return false;
        return sim.io.out(p.tag);
      },
      in(el, key, value) {
        const p = el.io && el.io[key];
        if (!p) return;
        const analog = typeof value === 'number';
        const hasOut = KIT[el.type].io(el).some((x) => x.dir === 'out');
        if (!hasOut && el.fault) {
          if (el.fault === 'stuck0') value = analog ? 0 : false;
          else if (el.fault === 'stuck1') value = analog ? RAW : true;
          else if (el.fault === 'break') value = analog ? (el.params.signal === '4-20 mA' ? -32768 : 0) : false;
        }
        sim.io.set(p.tag, value);
      },
      jammed: (el) => el.fault === 'jam',
      rate: (el) => (el.fault === 'slow' ? 0.25 : 1),
      carrier(el, vx, vz, keep = false) { sim.carriers.push({ rect: footprint(el), top: (el.y || 0) + heightOf(el), vx, vz, keep, el }); },
      blocker(rect, el, kind = null) { sim.blockers.push({ rect, kind, el }); },
      itemsIn(rect, y) {
        return sim.items.filter((it) => !it.gone && overlap(itemRect(it), rect) && (y == null || (it.y >= y - 0.6 && it.y <= y + 3.5)));
      },
      spawn(props) {
        if (sim.items.length >= 160) return null;
        const c = sim._carrierAt(props.x, props.z, null);
        const it = { id: ++itemSeq, y: c ? c.top : 0, vx: 0, vz: 0, speed: 0, age: 0, ...props };
        sim.items.push(it);
        return it;
      },
      remove(it) { it.gone = true; },
      push(el, dist) {
        const f = fwd(el);
        const [w] = sizeOf(el);
        const head = this.front(el, Math.max(0, dist - 0.5), 0.5, 1.8);
        sim.pushed.push(head);
        if (dist < 0.05) return;
        const edge = (f[0] !== 0 ? el.x * f[0] : el.z * f[1]) + w / 2 + dist; // head face along the stroke axis
        for (const it of this.itemsIn(this.front(el, 0, dist, 1.8), null)) {
          if (Math.abs(it.y - (el.y || 0)) > 2.2) continue;
          const half = (f[0] !== 0 ? itemRect(it).x2 - itemRect(it).x1 : itemRect(it).z2 - itemRect(it).z1) / 2;
          const pos = f[0] !== 0 ? it.x * f[0] : it.z * f[1];
          if (pos < edge + half) {
            if (f[0] !== 0) it.x = (edge + half) * f[0]; else it.z = (edge + half) * f[1];
            it.pushedT = 0.2;
          }
        }
      },
      pushedAt: (rect) => sim.pushed.some((h) => overlap(h, rect)),
      near(el, pred) {
        const r = footprint(el);
        const g = { x1: r.x1 - 0.6, z1: r.z1 - 0.6, x2: r.x2 + 0.6, z2: r.z2 + 0.6 };
        for (const o of sim.els) if (o !== el && pred(o) && overlap(g, footprint(o))) return { el: o, st: sim.st[o.id], def: KIT[o.type] };
        return null;
      },
      tankNear(el) { return this.near(el, (o) => KIT[o.type].isTank && !KIT[o.type].isDrain); },
      /** Move liquid through a pump or valve; returns the actual flow in L/s. */
      flow(el, rate, dt, gravity) {
        const src = sim._trace(el, 1);
        const dst = sim._trace(el, 0);
        if (!src || !dst || src.end.el === dst.end.el) return 0;
        const s = src.end; const d = dst.end;
        let q = rate;
        if (!s.def.infinite) {
          if (gravity) q *= Math.sqrt(Math.max(0, s.st.vol / s.el.params.capacity));
          q = Math.min(q, s.st.vol / dt);
        } else if (s.def.isDrain) return 0;
        if (q <= 0) return 0;
        const amount = q * dt;
        if (!s.def.infinite) { s.st.vol -= amount; s.st.qout += q; }
        if (d.def.isDrain) d.st.total += amount;
        else if (!d.def.infinite) {
          // mixing temperatures
          const before = d.st.vol;
          d.st.temp = before + amount > 0 ? (d.st.temp * before + s.st.temp * amount) / (before + amount) : d.st.temp;
          d.st.vol += amount;
          d.st.qin += q;
          if (d.st.vol > d.el.params.capacity) { d.st.overflow += d.st.vol - d.el.params.capacity; d.st.vol = d.el.params.capacity; }
        }
        for (const p of [...src.pipes, ...dst.pipes]) sim.st[p.id].flow = 1;
        return q;
      },
    };
  }

  _elementAt(x, z, except) {
    for (const el of this.els) if (el !== except && inside(footprint(el), x, z)) return el;
    return null;
  }

  /** Follow pipes from one port of a pump/valve to a tank, reservoir or drain. */
  _trace(el, endIndex) {
    const rot = (o, lx, lz) => { let x = lx; let z = lz; for (let k = 0; k < (o.rot || 0) % 4; k++) [x, z] = [-z, x]; return [x, z]; };
    const endsOf = (o) => KIT[o.type].ends(o).map(([lx, lz]) => { const [dx, dz] = rot(o, lx, lz); const n = Math.hypot(dx, dz) || 1; return { x: o.x + dx, z: o.z + dz, dx: dx / n, dz: dz / n }; });
    let cur = el;
    let end = endsOf(el)[endIndex];
    const pipes = [];
    for (let guard = 0; guard < 80; guard++) {
      const next = this._elementAt(end.x + end.dx * 0.5, end.z + end.dz * 0.5, cur);
      if (!next) return null;
      const def = KIT[next.type];
      if (def.isTank) return { end: { el: next, st: this.st[next.id], def }, pipes };
      if (next.type !== 'pipe' && next.type !== 'elbow') return null;
      const ends = endsOf(next);
      const k = ends.findIndex((e) => Math.hypot(e.x - end.x, e.z - end.z) < 0.3);
      if (k < 0) return null; // the pipe does not open toward us
      pipes.push(next);
      cur = next;
      end = ends[1 - k];
    }
    return null;
  }

  _carrierAt(x, z, y) {
    let best = null;
    for (const c of this.carriers) {
      if (!inside(c.rect, x, z)) continue;
      if (y != null && Math.abs(c.top - y) > 0.7) continue;
      if (!best || c.top > best.top) best = c;
    }
    return best;
  }

  /** Operate a button, switch … from the 3D scene or a test. action: 'down' | 'up' | 'click' */
  operate(el, action) {
    const st = this.st[el.id];
    const mode = KIT[el.type].operate;
    if (!st || !mode) return;
    if (mode === 'momentary') st.pressed = action === 'down' ? true : action === 'up' ? false : st.pressed;
    else if (action !== 'down') return;
    else if (mode === 'toggle') st.pressed = !st.pressed;
    else if (mode === 'cycle3') st.position = (st.position + 1) % 3;
    else if (mode === 'step10') st.value = st.value >= 100 ? 0 : Math.min(100, Math.round(st.value / 10) * 10 + 10);
  }

  step(dt) {
    this.time += dt;
    this.carriers = [];
    this.blockers = [];
    this.pushed = [];
    const W = this.W;
    // 1. actuators and passive carriers
    for (const el of this.els) { const d = KIT[el.type]; if (d.act) d.act(el, this.st[el.id], W, dt); }
    // 2. workpieces
    const items = this.items;
    for (const it of items) {
      if (it.gone) continue;
      it.age += dt;
      if (it.crashed) { it.crashT -= dt; if (it.crashT <= 0) it.gone = true; continue; }
      if (it.pushedT > 0) it.pushedT -= dt;
      let c = this._carrierAt(it.x, it.z, it.y);
      if (!c && it.age < 0.2) { c = this._carrierAt(it.x, it.z, null); if (c) it.y = c.top; } // just produced: settle on the belt below
      let vx = 0; let vz = 0;
      if (c) {
        it.carried = true;
        if (c.keep) { vx = it.hx * it.speed; vz = it.hz * it.speed; }
        else {
          vx = c.vx; vz = c.vz;
          const sp = Math.hypot(vx, vz);
          if (sp > 1e-6) {
            it.hx = vx / sp; it.hz = vz / sp; it.speed = sp;
            // drift to the middle of the belt
            const cx = (c.rect.x1 + c.rect.x2) / 2; const cz = (c.rect.z1 + c.rect.z2) / 2;
            if (it.hx !== 0) it.z += Math.max(-1.5 * dt, Math.min(1.5 * dt, cz - it.z)); else it.x += Math.max(-1.5 * dt, Math.min(1.5 * dt, cx - it.x));
          }
        }
      } else if (it.carried) { it.carried = false; if (!this._carrierAt(it.x, it.z, null)) it.y = this._floorAt(it.x, it.z); }
      const dx = vx * dt; const dz = vz * dt;
      let blocked = false;
      if (dx !== 0 || dz !== 0) {
        const now = itemRect(it);
        const nxt = { x1: now.x1 + dx, z1: now.z1 + dz, x2: now.x2 + dx, z2: now.z2 + dz };
        for (const b of this.blockers) {
          if (b.kind && b.kind !== it.kind) continue;
          if (overlap(nxt, b.rect) && !overlap(now, b.rect)) { blocked = true; break; }
        }
        if (!blocked) {
          const g = 0.12;
          const grown = { x1: nxt.x1 - g, z1: nxt.z1 - g, x2: nxt.x2 + g, z2: nxt.z2 + g };
          for (const o of items) {
            if (o === it || o.gone || Math.abs(o.y - it.y) > 1.2) continue;
            if ((o.x - it.x) * it.hx + (o.z - it.z) * it.hz <= 0) continue; // only what is ahead
            const or = itemRect(o);
            if (!overlap(grown, or)) continue;
            // crossing traffic: two moving things with different headings meet
            if (Math.abs(o.hx * it.hx + o.hz * it.hz) < 0.5 && it.kind === 'car' && o.kind === 'car' && o.moving && !o.crashed) {
              this.crashes++;
              it.crashed = o.crashed = true; it.crashT = o.crashT = 3;
            }
            blocked = true;
            break;
          }
        }
      }
      if (!blocked) { it.x += dx; it.z += dz; }
      it.vx = blocked ? 0 : vx; it.vz = blocked ? 0 : vz;
      it.moving = !blocked && (dx !== 0 || dz !== 0);
      it.waiting = blocked;
    }
    if (items.some((i) => i.gone)) this.items = items.filter((i) => !i.gone);
    // 3. sensors and operator elements
    for (const el of this.els) { const d = KIT[el.type]; if (d.sense) d.sense(el, this.st[el.id], W); }
  }

  _floorAt(x, z) {
    const el = this._elementAt(x, z, null);
    return el && (KIT[el.type].stackable || el.type === 'scale' || el.type === 'sink') ? (el.y || 0) + (el.type === 'sink' ? 0 : heightOf(el)) : 0;
  }

  status(el) {
    const d = KIT[el.type];
    return d.status ? d.status(el, this.st[el.id], this.W) : '';
  }

  /** Key figures of the whole scene (for the HUD and for document embeds). */
  summary() {
    const rows = [];
    for (const el of this.els) {
      const d = KIT[el.type];
      if (!d.status || ['pipe', 'elbow', 'road', 'crossing', 'lamp', 'horn', 'button', 'switch', 'brick'].includes(el.type)) continue;
      rows.push([el.name || d.name, d.status(el, this.st[el.id], this.W)]);
    }
    if (this.els.some((e) => e.type === 'road')) rows.unshift(['Crashes', this.crashes ? `⚠ ${this.crashes}` : '0']);
    return rows;
  }
}
