/**
 * Surface-neutral copy. These values describe the semantic answer; a surface
 * renderer decides whether a mention, link, emoji, button, or card is native.
 * @typedef {Object} StructuredContent
 * @property {'info'|'success'|'warning'|'error'} severity
 * @property {string} [code]
 * @property {Array<string|{mention:string}|{link:{url:string,label:string}}|{code:string,language?:string}>} parts
 * @property {Array<Record<string, unknown>>} [blocks]
 */

/** @param {string} text @param {'info'|'success'|'warning'|'error'} [severity] @param {string} [code] */
export function textContent(
	text,
	/** @type {'info'|'success'|'warning'|'error'} */ severity = "info",
	code,
) {
	return { severity, ...(code ? { code } : {}), parts: [String(text)] };
}

/**
 * Plain fallback used only by adapters that have not rendered a part yet.
 * @param {StructuredContent | null | undefined} content
 */
export function plainText(content) {
	return (content?.parts || [])
		.map((/** @type {any} */ part) => {
			if (typeof part === "string") return part;
			if (part?.mention) return `@${part.mention}`;
			if (part?.link) return part.link.label || part.link.url;
			if (part?.code) return String(part.code);
			return "";
		})
		.join("");
}

/**
 * @param {string} code
 * @param {string} [operation]
 * @param {Record<string, unknown>} [details]
 * @returns {StructuredContent}
 */
export function announcementFor(code, operation, details = {}) {
	const actor =
		typeof details.actorId === "string" ? { mention: details.actorId } : null;
	const link =
		typeof details.url === "string"
			? { link: { url: details.url, label: "follow it here" } }
			: null;
	const prefix = actor ? ["Approved by ", actor] : [];
	const suffix = link ? [" — ", link] : [];
	if (code === "approved") {
		const verb =
			operation === "cancel_eval_run"
				? "The run was cancelled"
				: "The approved action is complete";
		return { severity: "success", code, parts: [verb, ...prefix, ...suffix] };
	}
	if (code === "already_running")
		return textContent("That action is already running.", "info", code);
	if (code === "run_started") {
		return {
			severity: "info",
			code,
			parts: ["Run started", ...prefix, ...suffix],
		};
	}
	return textContent(
		typeof details.message === "string"
			? details.message
			: "The action could not be completed.",
		"error",
		code,
	);
}

/**
 * The user-value chain vocabulary, forked into this package on purpose.
 *
 * surface-core has ZERO dependencies so a bot can vendor the directory, which
 * rules out importing `@mcpjam/sdk/contract` here the way every other reader of
 * this vocabulary does. A fork of a CLOSED vocabulary that nothing checks is a
 * fork that goes stale silently, so the guard lives one package up:
 * `slack-app/tests/user-value-chain-labels.test.js` (slack-app may depend on
 * the SDK) asserts these three maps are total over `DECISION_LABEL_VOCABULARIES`
 * and that every value is byte-identical to the SDK's own label. Add a stage
 * reason to the contract and that test names this file.
 *
 * Deliberately NOT a `?? value` lookup at the call sites below: an unknown
 * member reads as ABSENT and drops the sentence, because the alternative is
 * printing `argumentMismatch` at a human — the exact failure the labels exist
 * to prevent, dressed up as having rendered something.
 */
export const CHAIN_STAGE_LABELS = Object.freeze({
	connection: "Connection",
	discovery: "Discovery",
	selection: "Selection",
	call: "Tool call",
	response: "Response",
	userValue: "User value",
});

/** The coarse bucket a non-passing run is grouped under. */
export const CHAIN_FAILURE_CATEGORY_LABELS = Object.freeze({
	setup: "setup",
	metadata: "tool metadata",
	selection: "tool selection",
	arguments: "call arguments",
	serverData: "server data",
	userValue: "user value",
	evaluator: "evaluator",
});

/** Why a stage landed where it did — fragments that complete "…because <x>". */
export const CHAIN_REASON_LABELS = Object.freeze({
	noSpanChannel: "this run captures no evidence channel for that stage",
	noEvidenceCaptured: "nothing eligible for that stage was captured",
	matchVerdictUnavailable:
		"extra tool calls were captured but the run did not report whether its match options tolerate them",
	traceAbsent: "the iteration recorded no trace",
	executorEmitsNoSpans: "the executor emitted no spans",
	blockedByPolicy: "a policy blocked the run before it could be measured",
	evaluatorError:
		"the evaluator itself failed, so the run says nothing about the server",
	providerError:
		"the model provider failed the call, so this stage was never measured",
	setupAborted: "the environment was never prepared, so the test never began",
	connectFailed:
		"the configured server was reached and initialize failed there",
	toolsListFailed: "initialize succeeded and listing tools failed",
	egressUnverified:
		"the connection failed with no evidence that our own network egress works",
	lifecycleStopped: "the run was stopped mid-flight",
	notAuthored: "the case asserts nothing this stage could decide",
	earlierStageFailed: "an earlier stage failed",
	missingToolCall: "an expected tool call was never made",
	unexpectedToolCall: "a tool call was made that the case did not expect",
	argumentMismatch: "the call arguments did not match what the case expects",
	toolError: "the server reported a tool error",
	protocolError: "the call never produced a result",
	renderFailed: "the widget did not render",
	predicateFailed: "a check on the result did not hold",
	observed: "the evidence was inspected and the stage held",
	impliedByLaterEvidence: "a later stage's success implies it",
	judgeObserved: "the LLM judge scored at or above the threshold",
	judgePartial:
		"the LLM judge scored inside the partial band — at or above the floor, below the threshold",
	judgeFailed: "the LLM judge scored below the partial floor",
	judgePending: "an LLM judge verdict is owed and has not arrived",
	judgeNotRequested: "no LLM judge verdict was ever owed",
});

/**
 * A member's label, or `undefined` for anything the map does not OWN.
 *
 * `map[member]` on its own is NOT that check, and the difference is visible in
 * somebody's channel. Every plain object inherits `constructor`, `toString`,
 * `valueOf` and friends from `Object.prototype`, so a payload whose `reason`
 * reads `"constructor"` resolves to a FUNCTION — truthy — and the callers
 * below, which drop the sentence on a falsy label, instead render
 * "First break: Selection — function Object() { [native code] }".
 *
 * Nothing on this path validates the payload against the vocabulary: the
 * watcher fetches the decision summary and hands it straight here. So the
 * own-property test is the whole guard, and it is what makes the maps' stated
 * contract — an unknown member reads as ABSENT — actually true.
 *
 * @param {Record<string, string>} map
 * @param {unknown} member
 * @returns {string | undefined}
 */
function labelFor(map, member) {
	return typeof member === "string" && Object.hasOwn(map, member)
		? map[member]
		: undefined;
}

/**
 * WHERE THE CHAIN BROKE, in one sentence, from a run's decision summary.
 *
 * The second half of the answer a terminal non-pass owes a reader: the outcome
 * line says what was decided and how much was measured; this says how far value
 * travelled before it stopped. Read from the FIRST diagnostic — the summary
 * orders them, and one break named precisely beats six rows nobody scrolls to
 * in a chat client.
 *
 * Returns "" rather than a hedge whenever the summary does not establish a
 * break: an unverified or absent chain, a stage this build has no word for, a
 * summary that never arrived. A caller appends nothing, and the outcome line is
 * exactly what it was before — which is the whole fail-soft contract.
 *
 * NOTHING HERE DIAGNOSES. A first failed stage is a LOCATION and a failure
 * category is a BUCKET; neither is a claim about why, and neither authorizes
 * telling a reader what to change.
 *
 * @param {any} summary the `decision-summary` resource, or null
 * @returns {string}
 */
export function formatFirstBreak(summary) {
	const chain = summary?.diagnostics?.items?.[0]?.chain;
	// `verified` alone carries stages: an `unverified` derivation had its claims
	// withheld on purpose, and `absent` never offered any.
	if (chain?.status !== "verified") return "";
	const stage = chain.firstFailedStage;
	if (typeof stage === "string") {
		const stageLabel = labelFor(CHAIN_STAGE_LABELS, stage);
		if (!stageLabel) return "";
		const row = (Array.isArray(chain.stages) ? chain.stages : []).find(
			(/** @type {any} */ candidate) => candidate?.stage === stage,
		);
		const reason = labelFor(CHAIN_REASON_LABELS, row?.reason);
		return reason
			? `First break: ${stageLabel} — ${reason}`
			: `First break: ${stageLabel}`;
	}
	// A setup abort and an evaluator error reach NO stage and still carry a
	// category — the derivation contract says so explicitly. Naming only the
	// bucket is the honest thing to say about a run that never got to a stage;
	// inventing a stage for it would put a location on a run that had none.
	const category = labelFor(
		CHAIN_FAILURE_CATEGORY_LABELS,
		chain.failureCategory,
	);
	return category ? `No stage was reached — grouped under ${category}` : "";
}

/**
 * What a finished run decided, and — for anything that is not a clean pass —
 * where its chain broke.
 *
 * `decisionSummary` is OPTIONAL and its absence is never an error: the watcher
 * fetches it fail-soft, so a deployment that does not serve the route, a read
 * that timed out, or a run with no verified chain all land here as `undefined`
 * and the line renders exactly as it did before the chain existed.
 *
 * @param {{status:string,result?:string|null,summary?:{passed?:number,total?:number}}} run
 * @param {string | {url?: string, actorId?: string} | null | undefined} url
 * @param {string} [actorId]
 * @param {any} [decisionSummary] the run's `decision-summary` resource, or null
 * @returns {StructuredContent}
 */
export function formatRunOutcome(run, url, actorId, decisionSummary) {
	if (url && typeof url === "object") {
		actorId = url.actorId;
		url = url.url;
	}
	const counts =
		run.summary?.total === undefined
			? ""
			: ` (${run.summary.passed ?? 0}/${run.summary.total} passed)`;
	const passed = run.status === "completed" && run.result === "passed";
	// BOTH conjuncts, mirroring the pass branch above it. The watcher only calls
	// this on a terminal status so the status half is defensive symmetry — but a
	// `result` read on its own is exactly how a still-running run's stale field
	// would get announced as a verdict.
	const inconclusive =
		run.status === "completed" && run.result === "inconclusive";
	const link = url
		? {
				link: {
					url,
					label: passed
						? "see the details"
						: inconclusive
							? "see what it measured"
							: "details",
				},
			}
		: null;
	const who = actorId ? [" — started by ", { mention: actorId }] : [];
	// On its own line, not spliced into the outcome sentence. The verdict and the
	// chain answer two different questions ("what was decided" and "how far did
	// value get"), and a chat client renders the break where a reader looks for
	// it rather than behind a fourth em-dash. The link in the line above is the
	// evidence pointer; `evidence.tracePath` is relative to the API root, so
	// there is no second URL a chat reader could follow.
	const chainLine = passed ? [] : chainLineParts(decisionSummary);
	if (passed)
		return {
			severity: "success",
			code: "run_passed",
			parts: [`Run passed${counts}`, ...who, ...(link ? [" — ", link] : [])],
		};
	if (run.status === "cancelled")
		return {
			severity: "info",
			code: "run_cancelled",
			parts: [
				"Run cancelled",
				...who,
				...(link ? [" — ", link] : []),
				...chainLine,
			],
		};
	if (run.status === "timed_out")
		return {
			severity: "warning",
			code: "run_timed_out",
			parts: [
				`Run timed out${counts}`,
				...who,
				...(link ? [" — ", link] : []),
				...chainLine,
			],
		};
	// A RUN STILL BEING GRADED HAS NOT FAILED. `grading` means every trial
	// finished and the run is held for its gating judge, so there is no verdict
	// yet — and falling through to the red branch below rendered it as "Run
	// grading — see what broke", which is red for a run nothing has decided.
	//
	// No counts and no chain line either: both describe a decided run, and a
	// pass count quoted here is the number the judge may still overturn.
	if (run.status === "grading")
		return {
			severity: "info",
			code: "run_grading",
			parts: [
				"Run is being graded by its judge",
				...who,
				...(link ? [" — ", link] : []),
			],
		};
	// A NO-VERDICT IS NOT A FAILURE. `inconclusive` is a decision the validity
	// phase reached — the run did not measure the server well enough to judge it
	// — and falling through to the red branch below rendered it as "Run
	// inconclusive — see what broke", sending a reader to hunt for a defect that
	// nothing in the run claims to have found.
	if (inconclusive)
		return {
			severity: "warning",
			code: "run_inconclusive",
			parts: [
				`Run inconclusive${counts} — it did not measure the server well enough to judge it`,
				...who,
				...(link ? [" — ", link] : []),
				...chainLine,
			],
		};
	return {
		severity: "error",
		code: "run_failed",
		parts: [
			`Run ${run.result === "failed" ? "failed" : run.status}${counts}`,
			...who,
			...(link ? [" — see what broke: ", link] : []),
			...chainLine,
		],
	};
}

/**
 * The chain sentence as message parts, or [] when there is none to tell.
 * @param {any} decisionSummary
 */
function chainLineParts(decisionSummary) {
	const sentence = formatFirstBreak(decisionSummary);
	return sentence ? ["\n", sentence] : [];
}

/**
 * The outcome line for a JOURNEY (Swarms) run, from the discriminated outcome
 * `journeyRunOutcome` produces — never from `status` alone, which reports a
 * deliberate stop as a failure and a mostly-failed completion as a pass.
 *
 * Session counts are in the line whenever the summary carried any, because
 * "finished" is not the verdict on a fan-out — 8/10 reaching the goal is. The
 * severity mapping is the part surfaces render as color, so `partial` is a
 * warning, not a success with a footnote.
 *
 * @param {{status?: string}} run
 * @param {{kind: string, succeeded: number, failed: number, rateLimited: number, total: number}} outcome
 * @param {string | {url?: string, actorId?: string} | null | undefined} url
 * @param {string} [actorId]
 * @returns {StructuredContent}
 */
export function formatJourneyRunOutcome(run, outcome, url, actorId) {
	if (url && typeof url === "object") {
		actorId = url.actorId;
		url = url.url;
	}
	const counts =
		outcome.total > 0
			? ` (${outcome.succeeded}/${outcome.total} sessions reached their goal)`
			: "";
	const link = url ? { link: { url, label: "see the sessions" } } : null;
	const who = actorId ? [" — approved by ", { mention: actorId }] : [];
	const tail = [...who, ...(link ? [" — ", link] : [])];
	switch (outcome.kind) {
		case "passed":
			return {
				severity: "success",
				code: "journey_run_passed",
				parts: [`Swarm run passed${counts}`, ...tail],
			};
		case "partial":
			return {
				severity: "warning",
				code: "journey_run_partial",
				parts: [`Swarm run finished mixed${counts}`, ...tail],
			};
		case "failed":
			return {
				severity: "error",
				code: "journey_run_failed",
				parts: [`Swarm run failed${counts}`, ...tail],
			};
		case "rate_limited":
			return {
				severity: "error",
				code: "journey_run_rate_limited",
				parts: [
					`Swarm run stopped early — model capacity ran out${counts}`,
					...tail,
				],
			};
		case "stopped":
			// Someone pressed stop. Nothing failed, and copy that says otherwise
			// sends the person who stopped it looking for a bug.
			return {
				severity: "info",
				code: "journey_run_stopped",
				parts: [`Swarm run stopped by request${counts}`, ...tail],
			};
		case "stalled":
			return {
				severity: "warning",
				code: "journey_run_stalled",
				parts: [
					`Swarm runner went silent — results are incomplete${counts}`,
					...tail,
				],
			};
		default:
			return {
				severity: "info",
				code: "journey_run_settled",
				parts: [`Swarm run settled${counts}`, ...tail],
			};
	}
}

/**
 * Evidence for a journey run as plain text lines, shared by every surface so
 * Slack and Discord cannot drift into describing the same scorecard
 * differently.
 *
 * The SCORECARD LEADS (it is deterministic and usually the whole answer);
 * sessions follow, worst first, as `collectJourneyRunEvidence` ranked them.
 * Returns [] when there is nothing worth posting — the caller should then
 * post nothing rather than an empty frame.
 *
 * @param {{scorecard: {criteria?: Array<{label?: string, criterionId?: string, kind?: string, passCount?: number, failCount?: number, pendingCount?: number}>} | null, sessions: Array<Record<string, any>>}} evidence
 * @param {{maxSessions?: number}} [opts]
 * @returns {string[]}
 */
export function formatJourneyRunEvidenceLines(evidence, opts = {}) {
	const lines = [];
	const criteria = evidence?.scorecard?.criteria ?? [];
	for (const criterion of criteria) {
		const name = criterion.label || criterion.criterionId || criterion.kind;
		const pass = criterion.passCount ?? 0;
		const fail = criterion.failCount ?? 0;
		const pending = criterion.pendingCount ?? 0;
		if (!name) continue;
		// Failing criteria carry the answer; all-pass criteria are one line of
		// reassurance each and are kept so a mixed scorecard reads as a whole.
		lines.push(
			`• ${name}: ${pass} passed, ${fail} failed${pending > 0 ? `, ${pending} pending` : ""}`,
		);
	}
	const sessions = (evidence?.sessions ?? []).slice(0, opts.maxSessions ?? 5);
	for (const session of sessions) {
		const who = session.personaLabel || session.personaId || "session";
		// Verdict from `outcome` (the attempt's end state) and the judge's
		// `goalScore` — never from `status`, which is the session's archival
		// flag and would print "active" as a verdict.
		const verdict =
			session?.goalScore?.passed === false
				? "did not reach the goal"
				: session?.outcome === "rate_limited"
					? "rate-limited"
					: session?.outcome === "failed"
						? "failed"
						: "finished";
		const preview =
			typeof session.preview === "string" && session.preview.length > 0
				? ` — “${session.preview.slice(0, 80)}”`
				: "";
		lines.push(`◦ ${who}: ${verdict}${preview}`);
	}
	return lines;
}

/** @param {string} message */
export function errorCopy(message) {
	return textContent(message, "error");
}

export const BUTTON_LABELS = Object.freeze({
	run_eval_suite: "Run it",
	run_eval_case: "Run it",
	generate_eval_cases: "Generate them",
	cancel_eval_run: "Cancel the run",
});

/** @param {string} message */
export function confirmCopy(
	message = "This action uses your organization quota.",
) {
	return textContent(message, "warning", "confirm");
}

/** @param {string} message */
export function sectionNote(message) {
	return textContent(message, "info", "note");
}
