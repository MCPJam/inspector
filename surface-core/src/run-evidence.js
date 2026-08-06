/**
 * Screenshot evidence for a finished run: which pictures to show, and how to
 * fetch them safely. Everything here is transport-neutral — a surface decides
 * only how the returned bytes become a native attachment.
 *
 * THE EXTRACTION IS MIRRORED, NOT IMPORTED. `@mcpjam/sdk/platform` exports an
 * equivalent `collectStepScreenshots`; importing it would pull a large runtime
 * into every bot image for a few dozen lines. The duplication is against the
 * SDK, deliberately, and the tests pin both sides.
 */

/** A handful of images per message is plenty on every surface. */
export const MAX_SCREENSHOTS = 5;

/**
 * Iterations to FETCH STEPS FOR. A suite runs every case × iteration, so a run
 * can have dozens; each step read costs a request against a bot that is
 * already holding a watcher open. Failed iterations are chosen first — a run
 * that failed in iteration 7 must not have its budget spent on the three
 * passing iterations that happened to come earlier.
 */
const MAX_ITERATIONS = 3;

/**
 * Iterations to LIST when choosing those three. Listing is one cheap JSON
 * request either way; the cap only bounds the page size.
 */
const ITERATIONS_PAGE = 25;

/** Per-image download budget. Signed artifact URLs are fast or they are broken. */
const DOWNLOAD_TIMEOUT_MS = 15_000;

/** Refuse anything implausible for a screenshot rather than buffering it. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Whether an iteration is one the failure story lives in.
 * @param {Record<string, any>} iteration
 */
export function isFailedIteration(iteration) {
	return (
		iteration?.status === "failed" ||
		iteration?.status === "timed_out" ||
		iteration?.result === "failed"
	);
}

/**
 * Screenshot URLs from a page of steps, in author order. Three decisions, all
 * deliberate:
 *   - ORDER by the steps' own `stepIndex`, not arrival order. The list is the
 *     story of what the run did, and out-of-order pictures tell it wrong.
 *   - DROP a repeated url. A video-backed run can reuse one frame across
 *     steps, and the same picture twice reads as two things having happened.
 *   - PREFER failing steps (see `selectStepScreenshots` below).
 *
 * @param {Array<Record<string, any>>} steps
 * @param {{ limit?: number, failedOnly?: boolean }} [options]
 * @returns {Array<{ url: string, stepId: string, stepIndex: number, status: string, label?: string }>}
 */
export function collectStepScreenshots(steps, options = {}) {
	// Before the loop, not only after a push: a post-push check alone returns
	// ONE entry for `limit: 0`.
	if (options.limit !== undefined && options.limit <= 0) return [];
	/** @type {Set<string>} */
	const seen = new Set();
	/** @type {Array<{ url: string, stepId: string, stepIndex: number, status: string, label?: string }>} */
	const found = [];
	const ordered = (Array.isArray(steps) ? [...steps] : []).sort(
		(left, right) => (left?.stepIndex ?? 0) - (right?.stepIndex ?? 0),
	);
	for (const step of ordered) {
		if (options.failedOnly && step?.status !== "fail") continue;
		const url = step?.evidence?.screenshotUrl;
		if (typeof url !== "string" || !url || seen.has(url)) continue;
		seen.add(url);
		found.push({
			url,
			stepId: String(step?.stepId ?? ""),
			stepIndex: Number(step?.stepIndex ?? 0),
			status: String(step?.status ?? ""),
			...(step?.evidence?.locatorLabel
				? { label: String(step.evidence.locatorLabel) }
				: {}),
		});
		if (options.limit !== undefined && found.length >= options.limit) break;
	}
	return found;
}

/**
 * The steps worth showing, preferring failures.
 *
 * When something failed, those steps ARE the answer and the passing ones are
 * noise. When nothing failed the run still deserves a picture, so fall back to
 * the whole sequence rather than returning nothing.
 *
 * @param {Array<Record<string, any>>} steps
 * @param {number} limit
 */
export function selectStepScreenshots(steps, limit) {
	const failed = collectStepScreenshots(steps, { failedOnly: true, limit });
	if (failed.length > 0) return failed;
	return collectStepScreenshots(steps, { limit });
}

/**
 * Download one artifact, bounded.
 *
 * The url comes from MCPJam's own API, but THIS PROCESS fetches it, so it is a
 * request target rather than a trusted constant. `https:` only, and redirects
 * are an ERROR rather than something to follow: a redirect is the one way a
 * url that passed this check could still land somewhere else, and an artifact
 * host that needs one is a change worth noticing.
 *
 * Handing the raw url to a platform SDK instead — letting IT do the fetch —
 * skips all three guards, which is why every surface takes bytes from here.
 *
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<Buffer>}
 */
export async function fetchImageBytes(url, opts = {}) {
	const target = new URL(url);
	if (target.protocol !== "https:") {
		throw new Error(`refusing a non-https artifact url (${target.protocol})`);
	}
	const fetchImpl = opts.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
	timer.unref?.();
	try {
		const response = await fetchImpl(url, {
			signal: controller.signal,
			redirect: "error",
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const declared = Number(response.headers.get("content-length") ?? "");
		if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
			throw new Error(
				`image is ${declared} bytes, over the ${MAX_IMAGE_BYTES} cap`,
			);
		}
		// Read INCREMENTALLY and stop the moment the cap is passed.
		// `content-length` is a claim: a chunked or dishonest response would
		// otherwise be buffered in full before anyone checked its size, which
		// turns an 8 MB ceiling into no ceiling at all.
		if (!response.body) return Buffer.alloc(0);
		/** @type {Array<Buffer>} */
		const chunks = [];
		let total = 0;
		for await (const chunk of /** @type {any} */ (response.body)) {
			const buffer = Buffer.from(chunk);
			total += buffer.byteLength;
			if (total > MAX_IMAGE_BYTES) {
				controller.abort();
				throw new Error(`image exceeded the ${MAX_IMAGE_BYTES} byte cap`);
			}
			chunks.push(buffer);
		}
		return Buffer.concat(chunks);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * A short, human caption for one screenshot.
 * @param {{ stepIndex: number, status: string, label?: string }} shot
 */
export function captionFor(shot) {
	const where = shot.label ? ` — ${shot.label}` : "";
	return `Step ${shot.stepIndex + 1}${where}${shot.status === "fail" ? " (failed)" : ""}`;
}

/**
 * A finished run's evidence, downloaded and captioned, ready to attach.
 *
 * Selection happens ACROSS THE WHOLE RUN, not per iteration. Selecting inside
 * the loop scoped both guarantees to one iteration: the duplicate-url check
 * never spanned the run (so a case repeated across iterations produced the
 * same frame twice), and the failure preference was per-iteration (so a
 * passing early iteration could spend the whole budget before a failing later
 * one was even read — hiding the one picture anybody wanted).
 *
 * Resolves rather than rejects on every failure path: this is the extra, and
 * the outcome message has already been posted by the time it runs.
 *
 * @param {{
 *   apiClient: { listEvalRunIterations: Function, getEvalRunSteps: Function },
 *   runId: string,
 *   ctx: any,
 *   limit?: number,
 *   fetchImpl?: typeof fetch,
 *   logger?: { warn?: (message: string) => void },
 * }} args
 * @returns {Promise<Array<{ bytes: Buffer, filename: string, caption: string }>>}
 */
export async function fetchRunEvidence(args) {
	const limit = args.limit ?? MAX_SCREENSHOTS;
	const warn = (/** @type {string} */ message) => args.logger?.warn?.(message);
	/** @type {Array<Record<string, any>>} */
	const allSteps = [];
	try {
		const iterations = await args.apiClient.listEvalRunIterations(
			args.runId,
			args.ctx,
			{ limit: ITERATIONS_PAGE },
		);
		// Failed iterations first, in their own order; passing ones only fill
		// whatever budget is left. Reading the first three REGARDLESS of status
		// was how a failure in iteration 4+ ended up illustrated by the passing
		// iterations before it.
		const prioritized = [
			...iterations.filter((/** @type {any} */ i) => isFailedIteration(i)),
			...iterations.filter((/** @type {any} */ i) => !isFailedIteration(i)),
		];
		for (const iteration of prioritized.slice(0, MAX_ITERATIONS)) {
			const iterationId =
				typeof iteration?.id === "string" ? iteration.id : null;
			if (!iterationId) continue;
			try {
				allSteps.push(
					...(await args.apiClient.getEvalRunSteps(
						args.runId,
						iterationId,
						args.ctx,
					)),
				);
			} catch (error) {
				// One unreadable iteration must not cost the others.
				warn(`Could not read steps for iteration ${iterationId}: ${error}`);
			}
		}
	} catch (error) {
		warn(`Could not read run evidence for ${args.runId}: ${error}`);
		return [];
	}

	const shots = selectStepScreenshots(allSteps, limit);
	/** @type {Array<{ bytes: Buffer, filename: string, caption: string }>} */
	const uploads = [];
	for (const shot of shots) {
		try {
			uploads.push({
				bytes: await fetchImageBytes(
					shot.url,
					args.fetchImpl ? { fetchImpl: args.fetchImpl } : {},
				),
				// Position-based, because `stepIndex` REPEATS across iterations — two
				// shots of step 3 from different iterations would otherwise share a
				// filename. The step is named in the caption, where it belongs.
				filename: `run-evidence-${uploads.length + 1}.png`,
				caption: captionFor(shot),
			});
		} catch (error) {
			// A screenshot we cannot download is one the user can still go and look
			// at in the app. Skip it and post the rest.
			//
			// The URL is NOT logged: an artifact url carries its own signed access,
			// so a log line containing one hands read access to every log reader.
			warn(
				`Could not download run evidence for run ${args.runId}, step ${shot.stepIndex}: ${error}`,
			);
		}
	}
	return uploads;
}
