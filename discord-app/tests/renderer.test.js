import assert from "node:assert/strict";
import test from "node:test";
import { contextFromMessage, isBotMention } from "../src/context.js";
import { turnContent } from "../src/copy.js";
import { chunkText, renderDiscord } from "../src/renderer.js";

test("Discord chunks text at 2,000 characters and only final chunk has components", () => {
	const payloads = renderDiscord(
		turnContent("x".repeat(4_500), [
			{ actionId: "action-1", operation: "run_eval_suite" },
		]),
	);
	assert.ok(payloads.length >= 3);
	assert.ok(payloads.every((payload) => payload.content.length <= 2_000));
	assert.equal(
		payloads.slice(0, -1).some((payload) => payload.components),
		false,
	);
	assert.equal(
		payloads.at(-1).components[0].components[0].custom_id,
		"action-1",
	);
});

test("Discord renderer always restricts mentions", () => {
	const payload = renderDiscord({
		severity: "info",
		parts: ["hello ", { mention: "123" }, " @everyone"],
	})[0];
	assert.deepEqual(payload.allowedMentions, {
		parse: [],
		users: ["123"],
		roles: [],
	});
});

test("history context rejects DMs and preserves guild tenancy", () => {
	const client = { user: { id: "bot" } };
	assert.equal(contextFromMessage({ guildId: null }, client), null);
	const message = {
		guildId: "guild",
		channelId: "channel",
		id: "1489000000000000000",
		author: { id: "user" },
		mentions: { users: new Map([["bot", {}]]) },
	};
	assert.deepEqual(contextFromMessage(message, client), {
		surfaceKind: "discord",
		tenantId: "guild",
		actorId: "user",
		conversationId: "channel",
		threadId: "1489000000000000000",
		isGuild: true,
		clientUserId: "bot",
	});
	assert.equal(isBotMention(message, client), true);
});

test("chunker keeps content intact", () => {
	const input = `${"a".repeat(1999)}\nb`;
	assert.equal(chunkText(input, 2000).join("\n"), input);
});
