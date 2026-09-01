/**
 * Every branch of `formatRunOutcome`, and the chain sentence beneath it.
 *
 * This file exists because one of these branches was MISSING: an `inconclusive`
 * run — a run that did not measure the server well enough to judge it — fell
 * through to the red "see what broke" branch and told every reader a defect had
 * been found. A no-verdict rendered as a failure is the single most expensive
 * thing a notification surface can say, so the branches are enumerated here
 * rather than sampled.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	CHAIN_FAILURE_CATEGORY_LABELS,
	CHAIN_REASON_LABELS,
	CHAIN_STAGE_LABELS,
	formatFirstBreak,
	formatRunOutcome,
	plainText,
} from "../src/index.js";

const url = "https://app.mcpjam.com/evals/suite/s1/runs/r1?project=p1";

/** A decision summary whose first diagnostic broke at `stage` for `reason`. */
function summaryWithBreak(stage, reason, extra = {}) {
	return {
		diagnostics: {
			items: [
				{
					chain: {
						status: "verified",
						stages: [
							{ stage: "connection", state: "passed", reason: "observed" },
							{ stage, state: "failed", reason },
						],
						firstFailedStage: stage,
						...extra,
					},
				},
			],
		},
	};
}

test("a passing run keeps its green line and asks for no chain", () => {
	const content = formatRunOutcome(
		{ status: "completed", result: "passed", summary: { passed: 3, total: 3 } },
		url,
		"U1",
		// Even handed a summary, a pass says nothing about a break: there isn't
		// one, and the watcher does not fetch this for a pass in the first place.
		summaryWithBreak("selection", "missingToolCall"),
	);
	assert.equal(content.severity, "success");
	assert.equal(content.code, "run_passed");
	assert.equal(
		plainText(content),
		"Run passed (3/3 passed) — started by @U1 — see the details",
	);
});

test("a failing run leads with the verdict and names the first break", () => {
	const content = formatRunOutcome(
		{ status: "completed", result: "failed", summary: { passed: 1, total: 3 } },
		url,
		"U1",
		summaryWithBreak("selection", "missingToolCall"),
	);
	assert.equal(content.severity, "error");
	assert.equal(content.code, "run_failed");
	assert.equal(
		plainText(content),
		"Run failed (1/3 passed) — started by @U1 — see what broke: details\n" +
			"First break: Selection — an expected tool call was never made",
	);
});

test("an INCONCLUSIVE run is a warning that did not measure enough", () => {
	// The regression this file was written for. `inconclusive` is a decision the
	// validity phase reached, not a defect anyone found.
	const content = formatRunOutcome(
		{
			status: "completed",
			result: "inconclusive",
			summary: { passed: 0, total: 2 },
		},
		url,
		"U1",
	);
	assert.equal(content.severity, "warning");
	assert.equal(content.code, "run_inconclusive");
	const text = plainText(content);
	assert.equal(
		text,
		"Run inconclusive (0/2 passed) — it did not measure the server well " +
			"enough to judge it — started by @U1 — see what it measured",
	);
	assert.ok(!text.includes("see what broke"), "must not blame the server");
	assert.ok(!text.includes("failed"), "must not read as a failure");
});

test("a cancelled run stays informational and still carries its chain", () => {
	const content = formatRunOutcome(
		{ status: "cancelled", result: null },
		url,
		"U1",
		summaryWithBreak("call", "argumentMismatch"),
	);
	assert.equal(content.severity, "info");
	assert.equal(content.code, "run_cancelled");
	assert.equal(
		plainText(content),
		"Run cancelled — started by @U1 — details\n" +
			"First break: Tool call — the call arguments did not match what the " +
			"case expects",
	);
});

test("a timed-out run is a warning, and never prints the raw status", () => {
	const content = formatRunOutcome(
		{ status: "timed_out", result: null, summary: { passed: 0, total: 2 } },
		url,
		"U1",
	);
	assert.equal(content.severity, "warning");
	assert.equal(content.code, "run_timed_out");
	const text = plainText(content);
	assert.ok(text.includes("Run timed out (0/2 passed)"));
	assert.ok(!text.includes("timed_out"), "raw status must not leak into copy");
});

test("an unknown terminal status falls through to the red branch", () => {
	const content = formatRunOutcome({ status: "exploded" }, url, "U1");
	assert.equal(content.code, "run_failed");
	assert.equal(
		plainText(content),
		"Run exploded — started by @U1 — see what broke: details",
	);
});

test("no url, no actor: the line is the verdict alone", () => {
	assert.equal(
		plainText(
			formatRunOutcome({ status: "completed", result: "inconclusive" }),
		),
		"Run inconclusive — it did not measure the server well enough to judge it",
	);
});

test("the chain is FAIL-SOFT: no summary renders the pre-chain line exactly", () => {
	// The watcher swallows every read error into `null`. A notification that
	// arrives without its enrichment beats one that never arrives.
	const bare = plainText(
		formatRunOutcome({ status: "failed", result: null }, url, "U1"),
	);
	assert.equal(bare, "Run failed — started by @U1 — see what broke: details");
	for (const absent of [null, undefined, {}, { diagnostics: { items: [] } }]) {
		assert.equal(
			plainText(
				formatRunOutcome({ status: "failed", result: null }, url, "U1", absent),
			),
			bare,
			`a ${JSON.stringify(absent)} summary must not change the line`,
		);
	}
});

test("an unverified or absent chain establishes no break", () => {
	// `unverified` had its claims withheld on purpose and `absent` never made
	// any. Neither is an invitation to guess where the chain stopped.
	for (const status of ["unverified", "absent"]) {
		assert.equal(
			formatFirstBreak({ diagnostics: { items: [{ chain: { status } }] } }),
			"",
		);
	}
});

test("a run that reached NO stage names its bucket, not a location", () => {
	// A setup abort and an evaluator error carry a failure category with no
	// first failed stage at all — the derivation contract says so explicitly.
	assert.equal(
		formatFirstBreak({
			diagnostics: {
				items: [
					{
						chain: { status: "verified", stages: [], failureCategory: "setup" },
					},
				],
			},
		}),
		"No stage was reached — grouped under setup",
	);
	assert.equal(
		formatFirstBreak({
			diagnostics: { items: [{ chain: { status: "verified", stages: [] } }] },
		}),
		"",
		"no stage and no category means there is nothing honest to say",
	);
});

test("a member this build has no word for drops the sentence", () => {
	// The alternative is printing `someStageFromTheFuture` at a human, which is
	// the exact failure the label maps exist to prevent — dressed up as having
	// rendered something.
	assert.equal(
		formatFirstBreak(summaryWithBreak("teleportation", "vibes")),
		"",
	);
	assert.equal(
		formatFirstBreak(summaryWithBreak("response", "vibesFromTheFuture")),
		"First break: Response",
		"a known stage with an unknown reason still has a location worth naming",
	);
});

test("the forked vocabulary is closed over its three maps", () => {
	// Byte-sync with the SDK is asserted one package up, where `@mcpjam/sdk` is
	// importable (slack-app/tests/user-value-chain-labels.test.js). What is
	// checkable HERE is that nothing shipped a partial map.
	assert.equal(Object.keys(CHAIN_STAGE_LABELS).length, 6);
	assert.equal(Object.keys(CHAIN_FAILURE_CATEGORY_LABELS).length, 7);
	assert.equal(Object.keys(CHAIN_REASON_LABELS).length, 29);
});
