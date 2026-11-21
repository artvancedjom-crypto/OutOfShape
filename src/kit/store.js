// Persistence for plants (IndexedDB store "scenes"). As with circuits, templates
// are never modified: the user edits a working copy stored as "tpl_<template>".
import { db } from '../core/db.js';
import { loadScene, newScene, sid } from './model.js';
import { templateScene, SCENE_TEMPLATE_IDS } from './templates.js';
import { ensureKitCatalog, registerSceneDefs, kitDefsUsedBy } from './catalog.js';

export const isSceneTemplate = (id) => SCENE_TEMPLATE_IDS.includes(id);
export const sceneWorkingId = (templateId) => 'tpl_' + templateId;

export async function openScene(id) {
  await ensureKitCatalog();
  if (isSceneTemplate(id)) {
    const saved = await db.get('scenes', sceneWorkingId(id));
    if (saved && saved.kind === 'scene') { registerSceneDefs(saved); return { doc: loadScene(saved), modified: true }; }
    return { doc: loadScene(templateScene(id)), modified: false };
  }
  const saved = await db.get('scenes', id);
  if (!saved || saved.kind !== 'scene') return null;
  registerSceneDefs(saved);
  return { doc: loadScene(saved), modified: false };
}

export async function saveScene(doc) {
  doc.updated = Date.now();
  doc.defs = kitDefsUsedBy(doc);
  await db.put('scenes', JSON.parse(JSON.stringify(doc)));
}

export async function resetSceneTemplate(templateId) {
  await db.del('scenes', sceneWorkingId(templateId));
  return loadScene(templateScene(templateId));
}

export async function saveSceneAs(doc, name) {
  registerSceneDefs(doc);
  const copy = loadScene(doc);
  copy.id = sid('s_');
  copy.name = name;
  copy.basedOn = doc.templateId || doc.basedOn || null;
  copy.templateId = null;
  copy.created = Date.now();
  await saveScene(copy);
  return copy;
}

export async function createScene() {
  const doc = newScene('My plant');
  await saveScene(doc);
  return doc;
}

export async function listUserScenes() {
  const all = await db.all('scenes');
  return all.filter((s) => s.kind === 'scene' && !String(s.id).startsWith('tpl_')).sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

export async function modifiedSceneTemplates() {
  const all = await db.all('scenes');
  return new Set(all.filter((s) => s.kind === 'scene' && String(s.id).startsWith('tpl_')).map((s) => s.templateId));
}

export const deleteScene = (id) => db.del('scenes', id);
