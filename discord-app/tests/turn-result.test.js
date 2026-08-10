import assert from "node:assert/strict";
import test from "node:test";
import { toDeliverableResult, toReplayContent } from "../turn-result.js";

/**
 * Pins the exact bug two independent reviewers caught on PR #3817: the
 * turn's reply text must survive the round trip through the core's
 * persisted-claim contract (`normalizeResult` in
 * surface-core/src/turn-runner.js, which reads ONLY `.reply`, a plain
 * string) as well as live delivery (which reads `.parts`,
 * StructuredContent). Losing either meant a redelivered event replayed
 * blank text — or, if there were no proposed-action buttons either, threw
 * trying to send an empty Discord message.
 */

test("toDeliverableResult carries BOTH .reply (for persistence) and .parts (for live delivery)", () => {
	const result = toDeliverableResult({
		reply: "the answer",
		proposedActions: [{ actionId: "a1" }],
	});
	assert.equal(result.reply, "the answer");
	assert.ok(Array.isArray(result.parts));
	assert.ok(result.parts.some((part) => part === "the answer"));
	assert.deepEqual(result.proposedActions, [{ actionId: "a1" }]);
});

test("toDeliverableResult defaults a missing reply to an empty string, not undefined", () => {
	const result = toDeliverableResult({});
	assert.equal(result.reply, "");
	assert.deepEqual(result.proposedActions, []);
});

test("toReplayContent rebuilds .parts from a persisted envelope's .reply — .parts never survived storage", () => {
	const content = toReplayContent({
		reply: "the stored answer",
		proposedActions: [{ actionId: "a1" }],
	});
	assert.ok(Array.isArray(content.parts));
	assert.ok(content.parts.some((part) => part === "the stored answer"));
	assert.deepEqual(content.proposedActions, [{ actionId: "a1" }]);
});

test("toReplayContent falls back to a visible placeholder rather than an empty message", () => {
	// An empty Discord message send can throw — a blank-but-successful reply
	// is bad; a thrown error replacing it with a scary failure is worse.
	const content = toReplayContent({});
	assert.ok(
		content.parts.some((part) => typeof part === "string" && part.length > 0),
	);
});
