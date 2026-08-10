import assert from "node:assert/strict";
import test from "node:test";
import {
	dedupe,
	EventDedupe,
	KeyedQueue,
	McpjamApiError,
	normalizeThreadMessages,
	runTurnForEvent,
} from "../src/index.js";

/**
 * These pin correctness properties the Slack fork (slack-app/agent/turn-runner.js)
 * has always had and this core's `runTurnForEvent` did not: what happens when
 * the durable-claim backend is unreachable, when a replay fails to post, and
 * which failures release a claim versus finalize it. All three matter because
 * this function is a durable claim state machine — getting the wrong exit
 * either double-bills a turn or silences an event forever.
 */

const CTX = { tenantId: "guild-1" };

function baseArgs(overrides = {}) {
	return {
		ctx: CTX,
		conversationId: "conv-1",
		triggerMessageId: "trigger-1",
		fallbackText: "hi",
		fetchHistory: async () => [],
		apiClient: {
			runAgentTurn: async () => ({
				reply: "done",
				toolCalls: [],
				createdResources: [],
				proposedActions: [],
			}),
		},
		onResult: async () => {},
		dedupe: new EventDedupe(),
		queue: new KeyedQueue(),
		...overrides,
	};
}

test("an unreachable claim backend releases the in-memory claim and rethrows (fail closed)", async () => {
	const localDedupe = new EventDedupe();
	const args = baseArgs({
		dedupe: localDedupe,
		eventClaims: {
			hasClaimBackend: () => true,
			claimEvent: async () => {
				throw new Error("backend down");
			},
		},
	});
	await assert.rejects(() => runTurnForEvent(args), /backend down/);
	// Released, not left in-flight: a retry against a healthy backend must be
	// able to claim this same event again, or the outage silences it forever.
	assert.equal(localDedupe.claim("guild-1:conv-1:trigger-1"), true);
});

test("a replay that fails to post releases the claim instead of burning the redelivery", async () => {
	const localDedupe = new EventDedupe();
	const args = baseArgs({
		dedupe: localDedupe,
		onReplay: async () => {
			throw new Error("post failed");
		},
		eventClaims: {
			hasClaimBackend: () => true,
			claimEvent: async () => ({
				outcome: "completed",
				resultEnvelope: { reply: "stored answer" },
			}),
		},
	});
	await assert.rejects(() => runTurnForEvent(args), /post failed/);
	assert.equal(localDedupe.claim("guild-1:conv-1:trigger-1"), true);
});

test("a pre-network CONFIG error releases the claim rather than finalizing a stale failure", async () => {
	const localDedupe = new EventDedupe();
	const completed = [];
	const args = baseArgs({
		dedupe: localDedupe,
		apiClient: {
			runAgentTurn: async () => {
				throw new McpjamApiError("missing credentials", { code: "CONFIG" });
			},
		},
		eventClaims: {
			hasClaimBackend: () => true,
			claimEvent: async () => ({ outcome: "claimed" }),
			completeEvent: async (key, envelope) => completed.push({ key, envelope }),
			releaseEvent: async () => {},
		},
	});
	await assert.rejects(() => runTurnForEvent(args), /missing credentials/);
	// Not finalized: an operator fixing the env var must not find the claim
	// still answering every redelivery with a stored failure for the next 72h.
	assert.equal(completed.length, 0);
	assert.equal(localDedupe.claim("guild-1:conv-1:trigger-1"), true);
});

test("a genuine post-dispatch failure (an HTTP status) is finalized, not released", async () => {
	// Contrast case for the one above: this error carries a status, so it is
	// proof a request reached the server — releasing here would let a
	// redelivery re-run a turn that may have already been billed.
	const localDedupe = new EventDedupe();
	const completed = [];
	const args = baseArgs({
		dedupe: localDedupe,
		apiClient: {
			runAgentTurn: async () => {
				throw new McpjamApiError("server exploded", {
					code: "SERVER_UNREACHABLE",
					status: 500,
				});
			},
		},
		eventClaims: {
			hasClaimBackend: () => true,
			claimEvent: async () => ({ outcome: "claimed" }),
			completeEvent: async (key, envelope) => completed.push({ key, envelope }),
			releaseEvent: async () => {
				throw new Error("must not be called on this path");
			},
		},
	});
	await assert.rejects(() => runTurnForEvent(args), /server exploded/);
	assert.equal(completed.length, 1);
	assert.equal(
		completed[0].envelope.reply,
		"I can't reach MCPJam right now. Try again in a moment.",
	);
});

test("the stored envelope on success is exactly the four fields, not the raw API result", async () => {
	const completed = [];
	const args = baseArgs({
		apiClient: {
			runAgentTurn: async () => ({
				reply: "done",
				toolCalls: [{ name: "x" }],
				createdResources: [],
				proposedActions: [],
				// Fields a future API response might add — must not leak into the
				// persisted contract.
				usage: { tokens: 500 },
				requestId: "req_123",
			}),
		},
		eventClaims: {
			hasClaimBackend: () => true,
			claimEvent: async () => ({ outcome: "claimed" }),
			completeEvent: async (_key, envelope) => completed.push(envelope),
		},
	});
	await runTurnForEvent(args);
	assert.deepEqual(completed[0], {
		reply: "done",
		toolCalls: [{ name: "x" }],
		createdResources: [],
		proposedActions: [],
	});
});

test("queueKey lets a caller override the default thread-vs-DM key", async () => {
	// Slack's threadTs is populated even for a top-level DM (it is the message's
	// own ts), so `threadId || 'root'` alone cannot tell a real thread from a DM
	// the way Discord's `undefined` can. A caller in that position must be able
	// to say so itself.
	const order = [];
	const sharedQueue = new KeyedQueue();
	const make = (id, queueKey) =>
		baseArgs({
			ctx: CTX,
			triggerMessageId: id,
			queue: sharedQueue,
			dedupe: new EventDedupe(),
			queueKey,
			fetchHistory: async () => {
				order.push(`start:${id}`);
				await new Promise((resolve) => setTimeout(resolve, 5));
				return [];
			},
			onResult: async () => order.push(`done:${id}`),
		});
	await Promise.all([
		runTurnForEvent(make("a", "same-key")),
		runTurnForEvent(make("b", "same-key")),
	]);
	// Same explicit queueKey: strictly serialized, so "a" finishes before "b"
	// starts.
	assert.deepEqual(order, ["start:a", "done:a", "start:b", "done:b"]);
});

test("the module-level dedupe/queue are the default — a caller that injects neither still dedupes", async () => {
	dedupe.clear();
	let calls = 0;
	const args = {
		ctx: { tenantId: "shared-test-tenant" },
		conversationId: "conv-shared",
		triggerMessageId: "trigger-shared",
		fallbackText: "hi",
		fetchHistory: async () => [],
		apiClient: {
			runAgentTurn: async () => {
				calls += 1;
				return {
					reply: "ok",
					toolCalls: [],
					createdResources: [],
					proposedActions: [],
				};
			},
		},
		onResult: async () => {},
		// Deliberately NOT passing dedupe/queue — this must still work.
	};
	const [first, second] = await Promise.all([
		runTurnForEvent(args),
		runTurnForEvent({ ...args }),
	]);
	assert.equal(first, true);
	assert.equal(second, false);
	assert.equal(calls, 1);
	dedupe.clear();
});

test("normalizeThreadMessages translates Slack's triggerTs so the newer-than-trigger cutoff actually fires", () => {
	const messages = normalizeThreadMessages(
		[
			{ user: "U1", ts: "1700000000.000000", text: "before the trigger" },
			{ user: "U1", ts: "1700000002.000000", text: "after the trigger" },
		],
		{ triggerTs: "1700000001.000000" },
	);
	assert.deepEqual(messages, [{ role: "user", content: "before the trigger" }]);
});
