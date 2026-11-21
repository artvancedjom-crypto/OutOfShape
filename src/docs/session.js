// What the document editor remembers while you are away in a simulation:
// zoom, scroll position and the undo/redo history. Kept in memory for the
// running app, so "back to the document" lands exactly where you left.
const sessions = new Map();

export function saveSession(docId, state) {
  sessions.set(docId, state);
}
export function takeSession(docId) {
  return sessions.get(docId) || null;
}
/** Record an undo step from outside the editor (e.g. applying an embedded simulation). */
export function pushUndo(docId, entry) {
  const s = sessions.get(docId);
  if (!s) return false;
  s.undo.push(entry);
  s.redo.length = 0;
  return true;
}
