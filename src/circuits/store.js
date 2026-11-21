// Persistence for circuit documents (IndexedDB store "circuits").
// Templates are never modified: the user edits a working copy stored under
// the id "tpl_<template>"; deleting that copy is "Reset to template".
import { db } from '../core/db.js';
import { loadCircuit, nid } from './model.js';
import { templateDoc, TEMPLATE_IDS } from './templates.js';
import { ensureCatalog, registerDocDefs, defsUsedBy } from './catalog.js';

export const isTemplateId = (id) => TEMPLATE_IDS.includes(id);
export const workingId = (templateId) => 'tpl_' + templateId;

/** Open by route id: a template id ("rc") or a saved circuit id. */
export async function openCircuit(id) {
  await ensureCatalog();
  if (isTemplateId(id)) {
    const saved = await db.get('circuits', workingId(id));
    if (saved) registerDocDefs(saved);
    return { doc: loadCircuit(saved || templateDoc(id)), modified: !!saved };
  }
  const saved = await db.get('circuits', id);
  if (saved) registerDocDefs(saved);
  return saved ? { doc: loadCircuit(saved), modified: false } : null;
}

export async function saveCircuit(doc) {
  doc.updated = Date.now();
  doc.defs = defsUsedBy(doc); // custom parts travel with the circuit
  await db.put('circuits', JSON.parse(JSON.stringify(doc)));
}

export async function resetTemplate(templateId) {
  await db.del('circuits', workingId(templateId));
  return loadCircuit(templateDoc(templateId));
}

/** Copy the document under a new id as a user circuit. */
export async function saveCircuitAs(doc, name) {
  registerDocDefs(doc);
  const copy = loadCircuit(doc);
  copy.id = nid('c_');
  copy.name = name;
  copy.basedOn = doc.templateId || doc.basedOn || null;
  copy.templateId = null;
  copy.created = Date.now();
  await saveCircuit(copy);
  return copy;
}

export async function listUserCircuits() {
  const all = await db.all('circuits');
  return all.filter((c) => !String(c.id).startsWith('tpl_') && !c.embedded).sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

export async function modifiedTemplates() {
  const all = await db.all('circuits');
  return new Set(all.filter((c) => String(c.id).startsWith('tpl_')).map((c) => c.templateId));
}

export const deleteCircuit = (id) => db.del('circuits', id);
