import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { watchDiscordJourneyRun } from "../watcher.js";

// The watcher sleeps on an `unref`'d timer; in the bot, the Gateway connection
// is what keeps the process up. Without a ref'd handle here the event loop
// drains during the first sleep, before any poll, and `node --test` cancels
// the test.
let keepAlive;
before(() => {
	keepAlive = setInterval(() => {}, 1_000);
});
after(() => {
	clearInterval(keepAlive);
});

/**
 * The Discord journey watcher end to end against a fake API: the status
 * message must be EDITED to the outcome, and evidence must arrive as a NEW
 * delivery only when the outcome warrants it. These are the two halves that
 * silently not happening is the bug this module exists to fix — an approved
 * swarm run whose thread never says how it went.
 */
function makeHandle() {
	const edits = [];
	return {
		edits,
		handle: {
			message: {
				edit: async (payload) => {
					edits.push(payload);
					return {};
				},
			},
		},
	};
}

test("edits the status to a mixed verdict and posts scorecard evidence", async () => {
	const { handle, edits } = makeHandle();
	const delivered = [];
	const run = {
		status: "completed",
		summary: { total: 10, succeeded: 6, failed: 4 },
	};
	const result = await watchDiscordJourneyRun({
		apiClient: {
			getJourneyRun: async () => run,
			getJourneyRunScorecard: async () => ({
				criteria: [{ label: "checkout completed", passCount: 6, failCount: 4 }],
			}),
			listJourneyRunSessions: async () => [
				{ personaLabel: "Impatient admin", outcome: "failed" },
			],
		},
		ctx: {},
		runId: "jr_1",
		handle,
		surfaceDelivery: {
			deliver: async (_ctx, content) => {
				delivered.push(content);
				return { handles: [] };
			},
		},
		url: "https://app/swarms/jr_1",
		actorId: "u1",
		intervalMs: 1,
		maxMs: 1_000,
	});

	assert.equal(result, run);
	assert.equal(edits.length, 1);
	// A completed run with failures is MIXED — the eval watcher's status-only
	// reading would have called this a pass.
	assert.match(edits[0].content, /mixed/);
	assert.match(edits[0].content, /6\/10 sessions/);
	assert.equal(delivered.length, 1);
	const evidence = String(delivered[0].parts?.[0] ?? "");
	assert.match(evidence, /checkout completed: 6 passed, 4 failed/);
	assert.match(evidence, /Impatient admin: failed/);
});

test("posts NO evidence under a green verdict", async () => {
	const { handle, edits } = makeHandle();
	const delivered = [];
	const fetched = [];
	await watchDiscordJourneyRun({
		apiClient: {
			getJourneyRun: async () => ({
				status: "completed",
				summary: { total: 3, succeeded: 3, failed: 0 },
			}),
			// Recorded, not thrown: collectJourneyRunEvidence swallows fetch
			// errors, so a throw here would let an ungated pass go unnoticed.
			getJourneyRunScorecard: async () => {
				fetched.push("scorecard");
				return { criteria: [] };
			},
			listJourneyRunSessions: async () => {
				fetched.push("sessions");
				return [];
			},
		},
		ctx: {},
		runId: "jr_2",
		handle,
		surfaceDelivery: {
			deliver: async (_ctx, content) => {
				delivered.push(content);
				return { handles: [] };
			},
		},
		intervalMs: 1,
		maxMs: 1_000,
	});
	assert.equal(edits.length, 1);
	assert.match(edits[0].content, /passed/);
	assert.deepEqual(fetched, []);
	assert.equal(delivered.length, 0);
});

test("says the run is still going when the watch window expires", async () => {
	const { handle, edits } = makeHandle();
	const result = await watchDiscordJourneyRun({
		apiClient: { getJourneyRun: async () => ({ status: "running" }) },
		ctx: {},
		runId: "jr_3",
		handle,
		url: "https://app/swarms/jr_3",
		intervalMs: 1,
		maxMs: 10,
	});
	// Null means WE stopped watching, not that the run stopped — and the
	// message must say so rather than staying on "running…" forever.
	assert.equal(result, null);
	assert.equal(edits.length, 1);
	assert.match(edits[0].content, /still going/);
	assert.match(edits[0].content, /jr_3/);
});
