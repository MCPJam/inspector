import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	collectJourneyRunEvidence,
	JOURNEY_TERMINAL_STATUSES,
	journeyOutcomeWantsEvidence,
	journeyRunOutcome,
	watchJourneyRunUntilDone,
} from "../src/journey-run-watcher.js";

/**
 * The journey watcher exists because reusing the eval one would report the
 * wrong thing in four specific ways. Each is pinned below, because each is a
 * message a real person reads and acts on.
 */

describe("journeyRunOutcome", () => {
	test("reports a deliberate stop as stopped, not failed", () => {
		// The backend has no `canceled` status literal — a stopped run comes back
		// `failed` with `canceled: true`. Reading status alone tells the person
		// who pressed Stop that their run failed, and sends them bug-hunting.
		const outcome = journeyRunOutcome({
			status: "failed",
			canceled: true,
			summary: { total: 10, succeeded: 3, failed: 7, rateLimited: 0 },
		});
		assert.equal(outcome.kind, "stopped");
	});

	test("reports a silent runner as stalled, not failed", () => {
		// The run did not fail on its merits; its runner stopped reporting. The
		// distinction is what tells someone the results are incomplete rather
		// than bad.
		const outcome = journeyRunOutcome({
			status: "failed",
			stale: true,
			summary: { total: 10, succeeded: 5, failed: 0, rateLimited: 0 },
		});
		assert.equal(outcome.kind, "stalled");
	});

	test("does not call a completed run with failures a pass", () => {
		// Journey runs carry no `result` field, so `status: completed` says only
		// that every attempt settled — not that any of them succeeded.
		const outcome = journeyRunOutcome({
			status: "completed",
			summary: { total: 10, succeeded: 2, failed: 8, rateLimited: 0 },
		});
		assert.equal(outcome.kind, "partial");
		assert.equal(outcome.failed, 8);
	});

	test("calls a clean completed run passed", () => {
		const outcome = journeyRunOutcome({
			status: "completed",
			summary: { total: 4, succeeded: 4, failed: 0, rateLimited: 0 },
		});
		assert.equal(outcome.kind, "passed");
		assert.equal(outcome.total, 4);
	});

	test("keeps rate limiting distinct from failure", () => {
		// "We ran out of model capacity" and "the product did not work" are
		// different problems with different owners.
		const outcome = journeyRunOutcome({
			status: "rate_limited",
			summary: { total: 10, succeeded: 1, failed: 0, rateLimited: 9 },
		});
		assert.equal(outcome.kind, "rate_limited");
		assert.equal(outcome.rateLimited, 9);
	});

	test("derives the total when the summary omits it", () => {
		const outcome = journeyRunOutcome({
			status: "completed",
			summary: { succeeded: 2, failed: 1, rateLimited: 1 },
		});
		assert.equal(outcome.total, 4);
	});
});

describe("journeyOutcomeWantsEvidence", () => {
	test("attaches evidence to the outcomes someone has to act on", () => {
		for (const kind of ["failed", "partial", "rate_limited", "stalled"]) {
			assert.equal(journeyOutcomeWantsEvidence({ kind }), true, kind);
		}
	});

	test("attaches none to a pass or a deliberate stop", () => {
		// Evidence under a green verdict is noise; a stop is not a problem.
		assert.equal(journeyOutcomeWantsEvidence({ kind: "passed" }), false);
		assert.equal(journeyOutcomeWantsEvidence({ kind: "stopped" }), false);
	});
});

describe("JOURNEY_TERMINAL_STATUSES", () => {
	test("treats rate_limited as terminal", () => {
		// It reads like a retryable condition and is not: the run is over. Polling
		// on would leave a status message spinning until the window expired.
		assert.equal(JOURNEY_TERMINAL_STATUSES.has("rate_limited"), true);
		assert.equal(JOURNEY_TERMINAL_STATUSES.has("running"), false);
	});
});

describe("collectJourneyRunEvidence", () => {
	test("ranks a failure that started after the shown set", async () => {
		// The API pages in START order. Requesting exactly `limit` would mean a
		// failure occurring later could never be selected as evidence, however
		// bad — so the pool asked for is wider than the set shown.
		let requestedLimit = 0;
		const evidence = await collectJourneyRunEvidence({
			apiClient: {
				getJourneyRunScorecard: async () => ({ criteria: [] }),
				listJourneyRunSessions: async (_runId, _ctx, opts) => {
					requestedLimit = opts.limit;
					return [
						...Array.from({ length: 20 }, (_, index) => ({
							id: `ok_${index}`,
							status: "completed",
						})),
						{ id: "late_failure", status: "failed" },
					];
				},
			},
			ctx: {},
			runId: "run_1",
			limit: 2,
		});
		assert.ok(requestedLimit > 2);
		assert.equal(evidence.sessions[0]?.id, "late_failure");
	});

	test("treats a rate-limited session as worth showing", async () => {
		// On a rate-limited run these ARE the relevant sessions; ranking them
		// below ordinary completions attaches the least useful evidence to
		// exactly the run that needs it.
		const evidence = await collectJourneyRunEvidence({
			apiClient: {
				getJourneyRunScorecard: async () => null,
				listJourneyRunSessions: async () => [
					{ id: "ok_1", status: "completed" },
					{ id: "limited", status: "rate_limited" },
				],
			},
			ctx: {},
			runId: "run_1",
			limit: 1,
		});
		assert.equal(evidence.sessions[0]?.id, "limited");
	});

	test("puts failed sessions first, whatever order they started in", async () => {
		// A run's first N sessions are whichever started first, which correlates
		// with nothing worth reading.
		const evidence = await collectJourneyRunEvidence({
			apiClient: {
				getJourneyRunScorecard: async () => ({ criteria: [] }),
				listJourneyRunSessions: async () => [
					{ id: "ok_1", status: "completed" },
					{ id: "bad_1", status: "failed" },
					{ id: "ok_2", status: "completed" },
					{ id: "bad_2", goalScore: { passed: false } },
				],
			},
			ctx: {},
			runId: "run_1",
			limit: 3,
		});
		assert.deepEqual(
			evidence.sessions.map((session) => session.id),
			["bad_1", "bad_2", "ok_1"],
		);
	});

	test("survives a run with no rubric", async () => {
		// The scorecard route 404s for a run with no rubric. That is the ordinary
		// case, not an error, and throwing would turn a missing nicety into a
		// failed status update.
		const evidence = await collectJourneyRunEvidence({
			apiClient: {
				getJourneyRunScorecard: async () => {
					throw new Error("404 Not Found");
				},
				listJourneyRunSessions: async () => [{ id: "s1" }],
			},
			ctx: {},
			runId: "run_1",
		});
		assert.equal(evidence.scorecard, null);
		assert.equal(evidence.sessions.length, 1);
	});

	test("survives a session listing that fails outright", async () => {
		const evidence = await collectJourneyRunEvidence({
			apiClient: {
				getJourneyRunScorecard: async () => ({ criteria: [] }),
				listJourneyRunSessions: async () => {
					throw new Error("boom");
				},
			},
			ctx: {},
			runId: "run_1",
		});
		assert.deepEqual(evidence.sessions, []);
		assert.notEqual(evidence.scorecard, null);
	});
});

/**
 * The watcher's sleep timer is `unref`'d — deliberately, so a live watcher
 * never holds a process open past its work. Under `node --test` that means the
 * event loop can drain while the watcher is mid-sleep and the runner cancels
 * the test. This keeps one ref'd handle alive for the duration of the call, so
 * the test observes the watcher rather than racing it.
 *
 * @template T
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
async function withLoopAlive(run) {
	const keepAlive = setInterval(() => {}, 1_000);
	try {
		return await run();
	} finally {
		clearInterval(keepAlive);
	}
}

describe("watchJourneyRunUntilDone", () => {
	test("edits the status message once the run settles", async () => {
		const edits = [];
		const run = await withLoopAlive(() =>
			watchJourneyRunUntilDone({
				apiClient: {
					getJourneyRun: async () => ({
						status: "completed",
						summary: { total: 2, succeeded: 2, failed: 0, rateLimited: 0 },
					}),
				},
				delivery: {
					edit: async (handle, body) => edits.push({ handle, body }),
				},
				statusHandle: "handle",
				ctx: {},
				runId: "run_1",
				url: "https://app.mcpjam.com/swarms/runs/run_1",
				actorId: "U1",
				pollIntervalMs: 1,
				maxMs: 500,
				formatOutcome: (_run, outcome) => `outcome:${outcome.kind}`,
			}),
		);
		assert.equal(run.status, "completed");
		assert.deepEqual(edits, [{ handle: "handle", body: "outcome:passed" }]);
	});

	test("returns null without claiming failure when the window expires", async () => {
		// Nothing failed; we stopped watching. Reporting a failure here would
		// tell someone their run broke when it is still going.
		const edits = [];
		const result = await withLoopAlive(() =>
			watchJourneyRunUntilDone({
				apiClient: { getJourneyRun: async () => ({ status: "running" }) },
				delivery: { edit: async (...args) => edits.push(args) },
				statusHandle: "handle",
				ctx: {},
				runId: "run_1",
				url: "u",
				actorId: "U1",
				pollIntervalMs: 1,
				maxMs: 20,
				formatOutcome: () => "unused",
				logger: { warn() {} },
			}),
		);
		assert.equal(result, null);
		assert.deepEqual(edits, []);
	});

	test("keeps polling through a transient poll failure", async () => {
		let calls = 0;
		const result = await withLoopAlive(() =>
			watchJourneyRunUntilDone({
				apiClient: {
					getJourneyRun: async () => {
						calls += 1;
						if (calls === 1) throw new Error("network");
						return {
							status: "partial",
							summary: { total: 2, succeeded: 1, failed: 1, rateLimited: 0 },
						};
					},
				},
				delivery: { edit: async () => {} },
				statusHandle: "handle",
				ctx: {},
				runId: "run_1",
				url: "u",
				actorId: "U1",
				pollIntervalMs: 1,
				maxMs: 500,
				formatOutcome: () => "done",
				logger: { warn() {} },
			}),
		);
		assert.equal(result.status, "partial");
		assert.equal(calls, 2);
	});

	test("settles a STALE run whose status never moved", async () => {
		// The sweep marks a run stale because its runner went silent, so nothing
		// will advance the status. Waiting on status alone polls for the whole
		// window and then reports "still running" about something long dead.
		const edits = [];
		const result = await withLoopAlive(() =>
			watchJourneyRunUntilDone({
				apiClient: {
					getJourneyRun: async () => ({
						status: "running",
						stale: true,
						summary: { total: 4, succeeded: 1, failed: 0, rateLimited: 0 },
					}),
				},
				delivery: { edit: async (_handle, body) => edits.push(body) },
				statusHandle: "handle",
				ctx: {},
				runId: "run_1",
				url: "u",
				actorId: "U1",
				pollIntervalMs: 1,
				maxMs: 500,
				formatOutcome: (_run, outcome) => outcome.kind,
			}),
		);
		assert.equal(result.stale, true);
		assert.deepEqual(edits, ["stalled"]);
	});

	test("returns a settled run even when the status edit throws", async () => {
		// The edit used to sit inside the poll's try/catch, so a failing edit
		// re-polled a run that was already over — and on a persistent failure the
		// watcher ran out its window and reported "still running" about a
		// finished run, never attaching evidence.
		let polls = 0;
		const followUps = [];
		const result = await withLoopAlive(() =>
			watchJourneyRunUntilDone({
				apiClient: {
					getJourneyRun: async () => {
						polls += 1;
						return {
							status: "completed",
							summary: { total: 1, succeeded: 1, failed: 0, rateLimited: 0 },
						};
					},
				},
				delivery: {
					edit: async () => {
						throw new Error("slack is down");
					},
				},
				statusHandle: "handle",
				ctx: {},
				runId: "run_1",
				url: "u",
				actorId: "U1",
				pollIntervalMs: 1,
				maxMs: 500,
				formatOutcome: () => "unused",
				onTerminal: async (_run, outcome) => followUps.push(outcome.kind),
				logger: { warn() {} },
			}),
		);
		assert.equal(result.status, "completed");
		assert.equal(polls, 1);
		// The evidence follow-up still runs: it does not depend on the edit.
		assert.deepEqual(followUps, ["passed"]);
	});

	test("still edits the status when the follow-up throws", async () => {
		// The status message is already correct by the time the follow-up runs;
		// an evidence failure must not make the run look unfinished.
		const edits = [];
		const result = await withLoopAlive(() =>
			watchJourneyRunUntilDone({
				apiClient: {
					getJourneyRun: async () => ({
						status: "failed",
						summary: { total: 1, succeeded: 0, failed: 1, rateLimited: 0 },
					}),
				},
				delivery: { edit: async (_handle, body) => edits.push(body) },
				statusHandle: "handle",
				ctx: {},
				runId: "run_1",
				url: "u",
				actorId: "U1",
				pollIntervalMs: 1,
				maxMs: 500,
				formatOutcome: (_run, outcome) => outcome.kind,
				onTerminal: async () => {
					throw new Error("evidence failed");
				},
				logger: { warn() {} },
			}),
		);
		assert.equal(result.status, "failed");
		assert.deepEqual(edits, ["failed"]);
	});
});

// ── Shared copy (copy.js) ───────────────────────────────────────────────────
// Tested here rather than in a copy test because the contract under test is
// the PAIRING: these formatters consume exactly what `journeyRunOutcome`
// produces, and drifting apart shows up as wrong words, not errors.

import {
	formatJourneyRunEvidenceLines,
	formatJourneyRunOutcome,
	plainText,
} from "../src/copy.js";

describe("formatJourneyRunOutcome", () => {
	const render = (run) =>
		plainText(
			formatJourneyRunOutcome(run, journeyRunOutcome(run), {
				url: "https://app/swarms/jr_1",
				actorId: "U1",
			}),
		);

	test("counts lead the verdict on every settled kind", () => {
		const line = render({
			status: "completed",
			summary: { total: 10, succeeded: 8, failed: 2 },
		});
		// completed-with-failures is MIXED — the formatter must follow the
		// outcome's reclassification, not the raw status.
		assert.match(line, /mixed/);
		assert.match(line, /8\/10 sessions reached their goal/);
	});

	test("a canceled run reads as stopped, with info severity", () => {
		const content = formatJourneyRunOutcome(
			{ status: "failed", canceled: true },
			journeyRunOutcome({ status: "failed", canceled: true }),
			{ url: "", actorId: "" },
		);
		assert.equal(content.severity, "info");
		assert.equal(content.code, "journey_run_stopped");
	});

	test("rate limiting is an error explained in words, not an enum", () => {
		const line = render({
			status: "rate_limited",
			summary: { total: 6, succeeded: 2, rateLimited: 4 },
		});
		assert.match(line, /model capacity ran out/);
		assert.doesNotMatch(line, /rate_limited/);
	});

	test("no counts clause when the run produced no sessions", () => {
		assert.doesNotMatch(render({ status: "failed" }), /0\/0/);
	});
});

describe("formatJourneyRunEvidenceLines", () => {
	test("scorecard leads, worst sessions follow", () => {
		const lines = formatJourneyRunEvidenceLines({
			scorecard: {
				criteria: [
					{ label: "checkout completed", passCount: 1, failCount: 7 },
					{ criterionId: "c2", passCount: 8, failCount: 0 },
				],
			},
			sessions: [
				{
					personaLabel: "Impatient admin",
					status: "completed",
					goalScore: { passed: false },
					preview: "I give up",
				},
				{ personaLabel: "Patient tester", status: "rate_limited" },
			],
		});
		assert.equal(lines.length, 4);
		assert.match(lines[0], /checkout completed: 1 passed, 7 failed/);
		// A criterion with no label still names itself by id.
		assert.match(lines[1], /c2: 8 passed, 0 failed/);
		assert.match(lines[2], /Impatient admin: did not reach the goal/);
		assert.match(lines[2], /I give up/);
		assert.match(lines[3], /Patient tester: rate-limited/);
	});

	test("caps sessions and returns [] when there is nothing to show", () => {
		assert.deepEqual(
			formatJourneyRunEvidenceLines({ scorecard: null, sessions: [] }),
			[],
		);
		const many = formatJourneyRunEvidenceLines(
			{
				scorecard: null,
				sessions: Array.from({ length: 9 }, (_, index) => ({
					personaLabel: `p${index}`,
					status: "failed",
				})),
			},
			{ maxSessions: 3 },
		);
		assert.equal(many.length, 3);
	});
});
