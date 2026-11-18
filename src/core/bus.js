// Small event bus + cross-view session state (e.g. "launched from document X").
const listeners = new Map();
export const bus = {
  on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); return () => listeners.get(ev).delete(fn); },
  emit(ev, data) { (listeners.get(ev) || []).forEach((f) => f(data)); },
};

// Hand-off payload when jumping from a document to a simulation.
export const session = {
  launch: null, // {docId, docName, page, targetId, params}
};
