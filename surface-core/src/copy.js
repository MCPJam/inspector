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
 * @param {{status:string,result?:string|null,summary?:{passed?:number,total?:number}}} run
 * @param {string | {url?: string, actorId?: string} | null | undefined} url
 * @param {string} [actorId]
 * @returns {StructuredContent}
 */
export function formatRunOutcome(run, url, actorId) {
	if (url && typeof url === "object") {
		actorId = url.actorId;
		url = url.url;
	}
	const counts =
		run.summary?.total === undefined
			? ""
			: ` (${run.summary.passed ?? 0}/${run.summary.total} passed)`;
	const link = url
		? {
				link: {
					url,
					label:
						run.status === "completed" && run.result === "passed"
							? "see the details"
							: "details",
				},
			}
		: null;
	const who = actorId ? [" — started by ", { mention: actorId }] : [];
	if (run.status === "completed" && run.result === "passed")
		return {
			severity: "success",
			code: "run_passed",
			parts: [`Run passed${counts}`, ...who, ...(link ? [" — ", link] : [])],
		};
	if (run.status === "cancelled")
		return {
			severity: "info",
			code: "run_cancelled",
			parts: ["Run cancelled", ...who, ...(link ? [" — ", link] : [])],
		};
	if (run.status === "timed_out")
		return {
			severity: "warning",
			code: "run_timed_out",
			parts: [`Run timed out${counts}`, ...who, ...(link ? [" — ", link] : [])],
		};
	return {
		severity: "error",
		code: "run_failed",
		parts: [
			`Run ${run.result === "failed" ? "failed" : run.status}${counts}`,
			...who,
			...(link ? [" — see what broke: ", link] : []),
		],
	};
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
	const sessions = (evidence?.sessions ?? []).slice(
		0,
		opts.maxSessions ?? 5,
	);
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
