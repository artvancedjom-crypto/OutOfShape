// Scenario registry. To add a scenario: create a module exporting the same
// shape as motor.js (metadata, io, params, programs, match, build) and list it here.
import motor from './motor.js';
import traffic from './traffic.js';
import tank from './tank.js';
import conveyor from './conveyor.js';
import bottling from './bottling.js';
import elevator from './elevator.js';

export const SCENARIOS = [motor, traffic, tank, conveyor, bottling, elevator];
export const getScenario = (id) => SCENARIOS.find((s) => s.id === id);
export const DIFFICULTY_ORDER = { Beginner: 0, Intermediate: 1, Advanced: 2 };
