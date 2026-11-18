// Document → simulation hand-off. Parameters travel in the URL so a reload
// keeps the configuration and the "back to document" link.
export function launchUrl(kind, id, { docId, page, params } = {}) {
  const q = new URLSearchParams();
  if (docId) q.set('doc', docId);
  if (page != null) q.set('page', String(page));
  if (params && Object.keys(params).length) q.set('params', JSON.stringify(params));
  const qs = q.toString();
  return `/${kind === 'plc' ? 'plc' : 'circuit'}/${id}${qs ? '?' + qs : ''}`;
}

export function parseLaunch(q) {
  let params = {};
  try { if (q.params) params = JSON.parse(q.params); } catch { /* ignore */ }
  return { docId: q.doc || null, page: q.page != null ? +q.page : null, params };
}
