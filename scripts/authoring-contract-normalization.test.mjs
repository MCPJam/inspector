import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAuthoringContract as normalize } from "./authoring-contract-normalization.mjs";
test("normalizes delimiters without erasing literal quote characters", () => {
  assert.equal(normalize(`export const EVAL_AUTHORING_VERSION = "hello";`), normalize(`export const EVAL_AUTHORING_VERSION = 'hello';`));
  assert.notEqual(normalize(`export const EVAL_AUTHORING_VERSION = 'say "hello"';`), normalize(`export const EVAL_AUTHORING_VERSION = "say 'hello'";`));
});
