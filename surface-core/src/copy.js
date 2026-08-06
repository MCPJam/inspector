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
