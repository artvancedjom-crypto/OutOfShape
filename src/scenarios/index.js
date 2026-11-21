// The PLC plants that documents can be matched to. Since version 1.2 every plant is
// a kit template (src/kit/templates.js); this module keeps the list in the shape
// the document matcher expects.
import { SCENE_TEMPLATES } from '../kit/templates.js';

export const SCENARIOS = SCENE_TEMPLATES;
export const getScenario = (id) => SCENARIOS.find((s) => s.id === id);
export const DIFFICULTY_ORDER = { Beginner: 0, Intermediate: 1, Advanced: 2 };
