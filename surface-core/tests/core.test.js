import assert from "node:assert/strict";
import test from "node:test";
import { normalizeThreadMessages } from "../src/index.js";

test("normalizes adapter-owned timestamps without parsing snowflakes", () => {
	const messages = normalizeThreadMessages(
		[
			{ id: "1750000000000000000", timestampMs: 1000, content: "before" },
			{ id: "1750000000000000001", timestampMs: 3000, content: "after" },
		],
		{ triggerTimestampMs: 2000 },
	);
	assert.deepEqual(messages, [{ role: "user", content: "before" }]);
});
