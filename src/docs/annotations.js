// Annotation model, canvas rendering, hit-testing and flattening into PDF.
// All coordinates are PDF points relative to the page's top-left corner
// (unrotated crop box), so annotations are resolution-independent and never
// touch the original PDF bytes until export.
import { getStroke } from 'perfect-freehand';
import { PDFDocument, rgb, StandardFonts, BlendMode, LineCapStyle } from 'pdf-lib';
import { wrapText, winAnsi } from './pdf.js';

export const PEN_OPTS = { thinning: 0.6, smoothing: 0.55, streamline: 0.45, start: { taper: 6 }, end: { taper: 8 } };

const pathCache = new WeakMap();

export function strokePath(o) {
  const cached = pathCache.get(o);
  if (cached && cached.n === o.points.length && cached.size === o.size) return cached.d;
  const pts = o.points;
  let outline;
  if (o.type === 'highlighter') {
    outline = getStroke(pts, { size: o.size, thinning: 0, smoothing: 0.5, streamline: 0.5, simulatePressure: false, start: { cap: false }, end: { cap: false } });
  } else {
    outline = getStroke(pts, { size: o.size, ...PEN_OPTS, simulatePressure: !!o.simulate });
  }
  const d = outlineToSvg(outline);
  pathCache.set(o, { n: pts.length, size: o.size, d });
  return d;
}

function outlineToSvg(points) {
  if (!points.length) return '';
  const r = (n) => Math.round(n * 100) / 100;
  let d = `M${r(points[0][0])} ${r(points[0][1])} Q`;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    d += ` ${r(x0)} ${r(y0)} ${r((x0 + x1) / 2)} ${r((y0 + y1) / 2)}`;
  }
  return d + ' Z';
}

export function shapePath(o) {
  const { x1, y1, x2, y2 } = o;
  switch (o.shape) {
    case 'rect': return `M${x1} ${y1} L${x2} ${y1} L${x2} ${y2} L${x1} ${y2} Z`;
    case 'ellipse': {
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;
      const rx = Math.abs(x2 - x1) / 2;
      const ry = Math.abs(y2 - y1) / 2;
      const k = 0.5523;
      return `M${cx - rx} ${cy} C${cx - rx} ${cy - ry * k} ${cx - rx * k} ${cy - ry} ${cx} ${cy - ry} C${cx + rx * k} ${cy - ry} ${cx + rx} ${cy - ry * k} ${cx + rx} ${cy} C${cx + rx} ${cy + ry * k} ${cx + rx * k} ${cy + ry} ${cx} ${cy + ry} C${cx - rx * k} ${cy + ry} ${cx - rx} ${cy + ry * k} ${cx - rx} ${cy} Z`;
    }
    case 'line': return `M${x1} ${y1} L${x2} ${y2}`;
    case 'arrow': {
      const a = Math.atan2(y2 - y1, x2 - x1);
      const L = Math.max(8, o.size * 4);
      const hx1 = x2 - L * Math.cos(a - 0.45);
      const hy1 = y2 - L * Math.sin(a - 0.45);
      const hx2 = x2 - L * Math.cos(a + 0.45);
      const hy2 = y2 - L * Math.sin(a + 0.45);
      return `M${x1} ${y1} L${x2} ${y2} M${hx1} ${hy1} L${x2} ${y2} L${hx2} ${hy2}`;
    }
  }
  return '';
}

export const TEXT_LINE = 1.25;

export function textLines(o, measure) {
  return wrapText(o.text || '', o.w, measure);
}

function canvasMeasure(ctx, size) {
  ctx.font = `${size}px Helvetica, Arial, sans-serif`;
  return (s) => ctx.measureText(s).width;
}

const imgCache = new Map();
function getImage(o, onload) {
  let im = imgCache.get(o.data);
  if (!im) {
    im = new Image();
    im.onload = onload;
    im.src = o.data;
    imgCache.set(o.data, im);
  }
  return im.complete && im.naturalWidth ? im : null;
}

/** Draw objects on a 2D context already scaled to page points. */
export function drawObjects(ctx, objs, { onImageLoad, selected } = {}) {
  for (const o of objs) {
    ctx.save();
    if (o.type === 'pen' || o.type === 'highlighter') {
      ctx.fillStyle = o.color;
      ctx.globalAlpha = o.opacity ?? 1;
      if (o.type === 'highlighter') ctx.globalCompositeOperation = 'multiply';
      ctx.fill(new Path2D(strokePath(o)));
    } else if (o.type === 'shape') {
      ctx.strokeStyle = o.color;
      ctx.lineWidth = o.size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke(new Path2D(shapePath(o)));
    } else if (o.type === 'text') {
      const measure = canvasMeasure(ctx, o.size);
      ctx.fillStyle = o.color;
      ctx.textBaseline = 'alphabetic';
      textLines(o, measure).forEach((ln, i) => ctx.fillText(ln, o.x, o.y + i * o.size * TEXT_LINE + o.size * 0.82));
    } else if (o.type === 'image') {
      const im = getImage(o, onImageLoad);
      if (im) ctx.drawImage(im, o.x, o.y, o.w, o.h);
      else { ctx.strokeStyle = '#999'; ctx.strokeRect(o.x, o.y, o.w, o.h); }
    }
    ctx.restore();
  }
  if (selected) {
    const b = bbox(selected, ctx);
    ctx.save();
    ctx.strokeStyle = '#4f7cff';
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.strokeRect(b.x - 3, b.y - 3, b.w + 6, b.h + 6);
    if (selected.type === 'image' || selected.type === 'text') {
      ctx.setLineDash([]);
      ctx.fillStyle = '#4f7cff';
      ctx.fillRect(b.x + b.w - 2, b.y + b.h - 2, 8, 8);
    }
    ctx.restore();
  }
}

let measureCtx = null;
export function bbox(o, ctx) {
  if (o.type === 'pen' || o.type === 'highlighter') {
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const [x, y] of o.points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const r = o.size / 2;
    return { x: x0 - r, y: y0 - r, w: x1 - x0 + 2 * r, h: y1 - y0 + 2 * r };
  }
  if (o.type === 'shape') {
    const r = o.size / 2 + 2;
    return { x: Math.min(o.x1, o.x2) - r, y: Math.min(o.y1, o.y2) - r, w: Math.abs(o.x2 - o.x1) + 2 * r, h: Math.abs(o.y2 - o.y1) + 2 * r };
  }
  if (o.type === 'text') {
    if (!ctx) { measureCtx = measureCtx || document.createElement('canvas').getContext('2d'); ctx = measureCtx; }
    const lines = textLines(o, canvasMeasure(ctx, o.size));
    return { x: o.x, y: o.y, w: o.w, h: Math.max(1, lines.length) * o.size * TEXT_LINE };
  }
  return { x: o.x, y: o.y, w: o.w, h: o.h };
}

function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Precise-ish hit test: strokes/lines by distance, others by bbox. */
export function hitTest(o, x, y, tol = 4) {
  if (o.type === 'pen' || o.type === 'highlighter') {
    const r = o.size / 2 + tol;
    const p = o.points;
    if (p.length === 1) return Math.hypot(p[0][0] - x, p[0][1] - y) < r;
    for (let i = 1; i < p.length; i++) if (distSeg(x, y, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]) < r) return true;
    return false;
  }
  if (o.type === 'shape' && (o.shape === 'line' || o.shape === 'arrow')) {
    return distSeg(x, y, o.x1, o.y1, o.x2, o.y2) < o.size / 2 + tol;
  }
  const b = bbox(o);
  return x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol;
}

export function translate(o, dx, dy) {
  if (o.points) o.points = o.points.map(([x, y, p]) => [x + dx, y + dy, p]);
  if (o.type === 'shape') { o.x1 += dx; o.x2 += dx; o.y1 += dy; o.y2 += dy; }
  if ('x' in o && o.type !== 'shape') { o.x += dx; o.y += dy; }
  pathCache.delete(o);
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function dataUrlBytes(url) {
  const b64 = url.split(',')[1];
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Flatten annotations into a copy of the original PDF. Returns Uint8Array. */
export async function exportAnnotatedPdf(originalBytes, pagesAnn) {
  const doc = await PDFDocument.load(originalBytes, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const imgEmbeds = new Map();
  for (let i = 0; i < pages.length; i++) {
    const objs = (pagesAnn && pagesAnn[i]) || [];
    if (!objs.length) continue;
    const page = pages[i];
    const crop = page.getCropBox();
    const ox = crop.x;
    const top = crop.y + crop.height;
    for (const o of objs) {
      if (o.type === 'pen' || o.type === 'highlighter') {
        page.drawSvgPath(strokePath(o), {
          x: ox, y: top, color: hexToRgb(o.color), opacity: o.opacity ?? 1,
          blendMode: o.type === 'highlighter' ? BlendMode.Multiply : BlendMode.Normal,
        });
      } else if (o.type === 'shape') {
        page.drawSvgPath(shapePath(o), {
          x: ox, y: top, borderColor: hexToRgb(o.color), borderWidth: o.size, borderLineCap: LineCapStyle.Round,
        });
      } else if (o.type === 'text') {
        const measure = (s) => font.widthOfTextAtSize(winAnsi(s), o.size);
        textLines(o, measure).forEach((ln, k) => {
          page.drawText(winAnsi(ln), { x: ox + o.x, y: top - (o.y + k * o.size * TEXT_LINE + o.size * 0.82), size: o.size, font, color: hexToRgb(o.color) });
        });
      } else if (o.type === 'image') {
        let img = imgEmbeds.get(o.data);
        if (!img) {
          const bytes = dataUrlBytes(o.data);
          img = o.data.startsWith('data:image/png') ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
          imgEmbeds.set(o.data, img);
        }
        page.drawImage(img, { x: ox + o.x, y: top - o.y - o.h, width: o.w, height: o.h });
      }
    }
  }
  return doc.save();
}
