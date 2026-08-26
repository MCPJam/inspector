import assert from "node:assert/strict";
import test from "node:test";
import { buildSetBlock, parseSetPair } from "../src/commands/clients.js";

/**
 * `--set key=value` is parsed by the FIELD, never guessed from the value.
 *
 * A generic "try JSON, fall back to string" parse is wrong in both directions
 * and silently so: it turns a system prompt of `123` into a number, a prompt of
 * `{"a":1}` into an object, and a `temperature=0.2x` typo into a string that
 * reaches the API and comes back rejected with a validator message naming a
 * type the user never chose to send. These tests pin one case per field family
 * plus the local refusals, because the value of the field-owned parse is
 * entirely in the cases the generic one gets wrong.
 */

test("string fields keep their value verbatim, JSON-looking or not", () => {
  assert.deepEqual(parseSetPair("systemPrompt=hello"), [
    "systemPrompt",
    "hello",
  ]);
  // The two cases a JSON-first parse mangles.
  assert.deepEqual(parseSetPair("systemPrompt=123"), ["systemPrompt", "123"]);
  assert.deepEqual(parseSetPair('systemPrompt={"a":1}'), [
    "systemPrompt",
    '{"a":1}',
  ]);
  // A value containing `=` belongs to the value, not to a second split.
  assert.deepEqual(parseSetPair("systemPrompt=a=b"), ["systemPrompt", "a=b"]);
});

test("numeric fields parse finite numbers and reject anything else", () => {
  assert.deepEqual(parseSetPair("temperature=0.2"), ["temperature", 0.2]);
  assert.deepEqual(parseSetPair("temperature=0"), ["temperature", 0]);
  assert.throws(() => parseSetPair("temperature=0.2x"), /expects a number/);
  assert.throws(() => parseSetPair("temperature="), /expects a number/);
  assert.throws(() => parseSetPair("temperature=Infinity"), /expects a number/);
});

test("boolean fields accept only the two literals", () => {
  assert.deepEqual(parseSetPair("requireToolApproval=true"), [
    "requireToolApproval",
    true,
  ]);
  assert.deepEqual(parseSetPair("requireToolApproval=false"), [
    "requireToolApproval",
    false,
  ]);
  // `1` and `yes` are refused rather than quietly decided: `x=maybe` silently
  // becoming `false` is the failure this rules out.
  assert.throws(
    () => parseSetPair("requireToolApproval=1"),
    /expects true or false/
  );
  assert.throws(
    () => parseSetPair("requireToolApproval=maybe"),
    /expects true or false/
  );
});

test("object and list fields require JSON", () => {
  assert.deepEqual(parseSetPair('builtInToolIds=["a","b"]'), [
    "builtInToolIds",
    ["a", "b"],
  ]);
  assert.deepEqual(parseSetPair('computer={"kind":"personal"}'), [
    "computer",
    { kind: "personal" },
  ]);
  assert.throws(() => parseSetPair("computer=personal"), /expects JSON/);
});

test("an unknown field names the settable ones", () => {
  assert.throws(() => parseSetPair("nope=1"), /Unknown client field "nope"/);
  assert.throws(() => parseSetPair("nope=1"), /modelId/);
});

test("--set without an `=` is a usage error", () => {
  assert.throws(() => parseSetPair("temperature"), /expects key=value/);
  assert.throws(() => parseSetPair("=0.2"), /expects key=value/);
});

test("--unset sends null, which the API reads as reset-or-clear", () => {
  assert.deepEqual(buildSetBlock(undefined, ["temperature", "harness"]), {
    temperature: null,
    harness: null,
  });
});

test("--unset modelId fails locally rather than travelling to be refused", () => {
  assert.throws(
    () => buildSetBlock(undefined, ["modelId"]),
    /--unset modelId is not allowed/
  );
  assert.throws(() => buildSetBlock(undefined, ["modelId"]), /pins no model/);
});

test("a field named by both --set and --unset is refused, not resolved", () => {
  assert.throws(
    () => buildSetBlock(["temperature=0.2"], ["temperature"]),
    /both name "temperature"/
  );
});

test("no --set and no --unset produces no set block at all", () => {
  assert.equal(buildSetBlock(undefined, undefined), undefined);
  assert.equal(buildSetBlock([], []), undefined);
});

test("--set and --unset combine into one block", () => {
  assert.deepEqual(buildSetBlock(["temperature=0.2"], ["harness"]), {
    temperature: 0.2,
    harness: null,
  });
});
