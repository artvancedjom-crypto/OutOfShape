// Versioned schemas for everything that is saved: each kind has a current version
// and a chain of migrations (index n upgrades version n → n+1). Old saves are
// upgraded on load; saves from a newer app version are refused with a clear error.
const kinds = {};

export function defineSchema(kind, version, migrations = []) {
  kinds[kind] = { version, migrations };
}

export function schemaVersion(kind) {
  return kinds[kind] ? kinds[kind].version : 1;
}

export function migrate(kind, obj) {
  const k = kinds[kind];
  if (!k || !obj) return obj;
  let v = obj.schema || 1;
  if (v > k.version) throw new Error(`This ${kind} was saved by a newer version of the app (schema ${v}, this app understands ${k.version}).`);
  let out = obj;
  while (v < k.version) {
    const step = k.migrations[v - 1];
    out = step ? step(out) : out;
    v++;
    out.schema = v;
  }
  return out;
}
