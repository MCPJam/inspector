import assert from "node:assert/strict";
import test from "node:test";
import { createApiClient } from "../src/api-client.js";
import { createBackendClient } from "../src/backend-client.js";
import { formatRunOutcome } from "../src/copy.js";
import { createEventClaims } from "../src/event-claims.js";
import {
	capMessageContent,
	EventDedupe,
	KeyedQueue,
	normalizeEnvelope,
	runTurnForEvent,
} from "../src/turn-runner.js";

test("normalizes adapter timestamps instead of parsing provider ids", () => {
	const result = normalizeEnvelope(
		[
			{ messageId: "1489000000000000000", timestampMs: 1000, content: "old" },
			{
				messageId: "1489000000000000001",
				timestampMs: 2000,
				content: "trigger",
			},
			{
				messageId: "1489000000000000002",
				timestampMs: 3000,
				content: "future",
			},
		],
		{ triggerTimestampMs: 2000, triggerMessageId: "1489000000000000001" },
	);
	assert.deepEqual(
		result.map((message) => message.content),
		["old", "trigger"],
	);
});

test("caps content by both code points and UTF-8 bytes", () => {
	const capped = capMessageContent("🙂".repeat(10_000));
	assert.ok(Buffer.byteLength(capped) <= 8192);
	assert.ok(capped.endsWith("…"));
});

test("dedupe claims expire only after completion", () => {
	let now = 0;
	const dedupe = new EventDedupe({ ttlMs: 10, now: () => now });
	assert.equal(dedupe.claim("a"), true);
	now = 100;
	assert.equal(dedupe.claim("a"), false);
	dedupe.complete("a");
	now = 111;
	assert.equal(dedupe.claim("a"), true);
});

test("keyed queue serializes one conversation and not another", async () => {
	const queue = new KeyedQueue();
	const events = [];
	await Promise.all([
		queue.enqueue("one", async () => {
			events.push("one-start");
			await new Promise((resolve) => setTimeout(resolve, 5));
			events.push("one-end");
		}),
		queue.enqueue("one", async () => events.push("one-second")),
		queue.enqueue("two", async () => events.push("two")),
	]);
	assert.ok(events.indexOf("one-end") < events.indexOf("one-second"));
});

test("surface API injects generic identity and conversation wire names", async () => {
	const previousKey = process.env.MCPJAM_SURFACE_API_KEY;
	process.env.MCPJAM_SURFACE_API_KEY = "dsc_test";
	const requests = [];
	const client = createApiClient({
		baseUrl: "https://example.test",
		fetchImpl: async (url, init) => {
			requests.push({ url, init });
			return new Response(JSON.stringify({ reply: "ok" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		},
	});
	await client.runAgentTurn(
		[{ role: "user", content: "hello" }],
		{ tenantId: "guild-1", actorId: "user-1", projectId: "project-1" },
		{ conversationId: "channel-1", idempotencyKey: "discord:event-1" },
	);
	assert.equal(
		requests[0].url,
		"https://example.test/api/v1/projects/project-1/agent",
	);
	assert.equal(
		requests[0].init.headers["x-mcpjam-surface-tenant-id"],
		"guild-1",
	);
	assert.equal(JSON.parse(requests[0].init.body).conversationId, "channel-1");
	if (previousKey === undefined) delete process.env.MCPJAM_SURFACE_API_KEY;
	else process.env.MCPJAM_SURFACE_API_KEY = previousKey;
});

test("event claims namespace keys by surface", async () => {
	const seen = [];
	const claims = createEventClaims({
		surfaceKind: "discord",
		backend: {
			claimEvent: async (key) => {
				seen.push(key);
				return { outcome: "claimed" };
			},
		},
	});
	await claims.claimEvent("guild:event");
	assert.equal(seen[0], "discord:guild:event");
});

test("Discord claim configuration does not fall back to a Slack token", () => {
	const previous = {
		url: process.env.MCPJAM_CONVEX_HTTP_URL,
		discord: process.env.MCPJAM_DISCORD_SERVICE_TOKEN,
		discordShort: process.env.DISCORD_SERVICE_TOKEN,
		slack: process.env.SLACK_SERVICE_TOKEN,
	};
	process.env.MCPJAM_CONVEX_HTTP_URL = "https://convex.example";
	delete process.env.MCPJAM_DISCORD_SERVICE_TOKEN;
	delete process.env.DISCORD_SERVICE_TOKEN;
	process.env.SLACK_SERVICE_TOKEN = "slk_test";
	const claims = createEventClaims({
		surfaceKind: "discord",
		backend: {},
	});
	assert.equal(claims.hasClaimBackend(), false);
	if (previous.url === undefined) delete process.env.MCPJAM_CONVEX_HTTP_URL;
	else process.env.MCPJAM_CONVEX_HTTP_URL = previous.url;
	if (previous.discord === undefined)
		delete process.env.MCPJAM_DISCORD_SERVICE_TOKEN;
	else process.env.MCPJAM_DISCORD_SERVICE_TOKEN = previous.discord;
	if (previous.discordShort === undefined)
		delete process.env.DISCORD_SERVICE_TOKEN;
	else process.env.DISCORD_SERVICE_TOKEN = previous.discordShort;
	if (previous.slack === undefined) delete process.env.SLACK_SERVICE_TOKEN;
	else process.env.SLACK_SERVICE_TOKEN = previous.slack;
});

test("surface backend sends both neutral and Slack thread field names", async () => {
	const client = createBackendClient({
		surfaceKind: "discord",
		baseUrl: "https://convex.example",
		serviceToken: "dsc_test",
		fetchImpl: async (_url, init) => {
			const body = JSON.parse(init.body);
			assert.equal(body.threadId, "thread-1");
			assert.equal(body.threadTs, "thread-1");
			return new Response(JSON.stringify({ binding: null }), { status: 200 });
		},
	});
	await client.fetchThreadBinding(
		{ tenantId: "guild-1", actorId: "user-1" },
		"channel-1",
		"thread-1",
	);
});

test("durable claim failure releases the local dedupe fast path", async () => {
	const dedupe = new EventDedupe();
	const args = {
		ctx: { tenantId: "guild-1", actorId: "user-1" },
		conversationId: "channel-1",
		triggerMessageId: "message-1",
		eventId: "event-1",
		eventClaims: {
			hasClaimBackend: () => true,
			claimEvent: async () => {
				throw new Error("claim backend down");
			},
		},
		dedupe,
	};
	await assert.rejects(runTurnForEvent(args), /claim backend down/);
	assert.equal(dedupe.claim("guild-1:channel-1:message-1"), true);
});

test("run outcome remains structured", () => {
	assert.deepEqual(
		formatRunOutcome(
			{
				status: "completed",
				result: "passed",
				summary: { passed: 2, total: 2 },
			},
			"https://example.test/run",
			"user-1",
		),
		{
			severity: "success",
			code: "run_passed",
			parts: [
				"Run passed (2/2 passed)",
				" — started by ",
				{ mention: "user-1" },
				" — ",
				{ link: { url: "https://example.test/run", label: "see the details" } },
			],
		},
	);
});
