// Fixture for node-builtin-guard.test.ts, not part of any shipped entry. Imports
// two builtins the guard's former hand-listed regex omitted, one bare and one
// `node:`-prefixed.
import { EventEmitter } from "events";
import { promisify } from "node:util";

export const leaked = [EventEmitter, promisify];
