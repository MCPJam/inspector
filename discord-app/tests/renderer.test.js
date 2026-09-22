import assert from "node:assert/strict";
import test from "node:test";
import { chunkDiscordText, renderDiscord } from "../renderer.js";

test("Discord renderer restricts mentions", () => {
	const payload = renderDiscord({
		parts: [{ mention: "123" }, " hi @everyone"],
	});
	assert.deepEqual(payload.allowedMentions, { parse: [], users: ["123"] });
	assert.match(payload.content, /\\@everyone/);
});

test("Discord chunks at the platform limit", () =>
	assert.equal(
		chunkDiscordText("a".repeat(4001))
			.map((item) => item.length)
			.join(","),
		"2000,2000,1",
	));
