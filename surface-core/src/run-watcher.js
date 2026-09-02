export const TERMINAL_STATUSES = new Set([
	"completed",
	"failed",
	"cancelled",
	"timed_out",
]);

/**
 * Whether a terminal run is the FAILURE case.
 *
 * Two shapes mean failure and only one of them says so: `status: "failed"`, and
 * a run that COMPLETED with `result: "failed"` — it finished, its cases did
 * not pass. A surface that checked only `status` would call the second one a
 * success.
 *
 * Shared rather than duplicated per surface because it gates EVIDENCE: posting
 * failure screenshots under a green "run passed" is noise, and hiding them
 * under a red verdict actively misleads whoever approved the spend. Slack has
 * had this exact predicate since its run-watcher shipped; Discord was checking
 * `status` alone.
 *
 * @param {{ status?: string, result?: string | null }} run
 */
export function isFailedOutcome(run) {
	return (
		run?.status === "failed" ||
		(run?.status === "completed" && run?.result === "failed")
	);
}

/**
 * Whether a terminal run's outcome line should carry the chain sentence.
 *
 * EVERYTHING BUT A CLEAN PASS, which is deliberately wider than
 * {@link isFailedOutcome}: a run that timed out, was cancelled, or came back
 * `inconclusive` also has a chain worth reading, and the last of those is
 * precisely the run whose reader has the least idea what happened. Narrowing
 * this to failures would leave the no-verdict case — the one this work exists
 * to stop misreporting — as the only outcome with nothing to say for itself.
 *
 * @param {{ status?: string, result?: string | null }} run
 */
export function wantsDecisionChain(run) {
	return !(run?.status === "completed" && run?.result === "passed");
}

/**
 * The run's decision summary, or null — never a throw.
 *
 * FAIL-SOFT IS THE WHOLE POLICY. The chain sentence is an enrichment on a
 * notification somebody is waiting for: a deployment that does not serve the
 * route, a read that timed out, a client that predates the method all have to
 * degrade to the outcome line that shipped before this existed. A notification
 * that never arrives because its enrichment 404'd is strictly worse than one
 * that arrives without it.
 *
 * @param {{apiClient?:any,runId:string,ctx:any,logger?:any}} args
 */
async function readDecisionSummarySoftly(args) {
	if (typeof args.apiClient?.getEvalRunDecisionSummary !== "function")
		return null;
	try {
		return await args.apiClient.getEvalRunDecisionSummary(args.runId, args.ctx);
	} catch (error) {
		args.logger?.warn?.(`Run decision summary read failed: ${error}`);
		return null;
	}
}

/**
 * The SECOND edit: the same outcome, re-rendered with the run's decision chain.
 *
 * Skipped whenever it would change nothing. A summary can arrive perfectly well
 * and still carry no sentence to add — an `unverified` chain withholds its rows
 * and an `absent` one never stored any, and both render byte-identical to the
 * verdict already on screen. The check is over the RENDERED OUTPUT rather than
 * over the summary because only the formatter knows what it will use, and each
 * surface brings its own; comparing the two renders asks the only question that
 * matters, which is whether this write would change what somebody reads.
 *
 * Never throws: the verdict is already delivered, so losing this edit costs a
 * sentence rather than the notification.
 *
 * @param {{apiClient?:any,delivery:any,statusHandle:any,ctx:any,runId:string,url:string,actorId:string,logger?:any,formatOutcome:(run:any,url:string,actorId:string,decisionSummary?:any)=>any}} args
 * @param {{status?:string,result?:string|null}} run
 * @param {unknown} verdict the unenriched render already on screen
 */
async function enrichWithDecisionChain(args, run, verdict) {
	if (!wantsDecisionChain(run)) return;
	const decisionSummary = await readDecisionSummarySoftly(args);
	if (!decisionSummary) return;
	// The FORMAT and the comparison are inside the try, not just the edit: a
	// surface's formatter is caller code, and `Promise.allSettled` below would
	// swallow a throw from it without a word — losing the enrichment silently
	// is the one failure mode worse than losing it loudly.
	try {
		const enriched = args.formatOutcome(
			run,
			args.url,
			args.actorId,
			decisionSummary,
		);
		// Both renders come from one formatter on one run, so key order is
		// stable and stringify is a sound equality here.
		if (JSON.stringify(enriched) === JSON.stringify(verdict)) return;
		await args.delivery.edit(args.statusHandle, enriched);
	} catch (error) {
		args.logger?.warn?.(`Run chain enrichment edit failed: ${error}`);
	}
}

/**
 * The completion follow-up, which a surface uses to post failure evidence.
 *
 * Never throws: an unhandled rejection here would take down a watcher whose
 * outcome message is already correct, trading the important thing for the
 * extra.
 *
 * @param {{onTerminal?:(run:any)=>Promise<void>,logger?:any}} args
 * @param {any} run
 */
async function runTerminalHook(args, run) {
	try {
		await args.onTerminal?.(run);
	} catch (error) {
		args.logger?.warn?.(`Run completion follow-up failed: ${error}`);
	}
}

/**
 * Polling is surface-neutral because the adapter owns the edit operation and
 * returns the exact status handle that can be edited.
 *
 * `formatOutcome` is REQUIRED, not defaulted. It used to fall back to
 * `copy.js`'s `formatRunOutcome`, which returns a `StructuredContent` object
 * — a caller whose `delivery.edit` expects a string (not every adapter
 * stringifies defensively the way discord-app's `plainText()` does) would
 * silently print `[object Object]` on every terminal run instead of getting
 * a type error at the call site. Every surface has an opinion on this copy
 * anyway (Slack's own mrkdwn-emoji version has never used the default), so
 * there is no "reasonable default" to fall back to — only a per-surface one.
 *
 * `formatOutcome` is called TWICE on a terminal non-pass, and the order is the
 * point: once immediately with `null`, so the verdict is delivered without
 * waiting on anything, and again with the run's DECISION SUMMARY once that read
 * returns something. A surface therefore names where the chain broke without
 * growing its own fetch, and without the enrichment ever deciding when the
 * verdict lands. See {@link wantsDecisionChain} for which runs are asked at all.
 *
 * The second edit is not guaranteed. It is skipped when the read fails, when it
 * returns nothing, and when the re-render would be identical to the verdict —
 * so a caller may observe one edit or two, and must not depend on which.
 * `onTerminal` runs CONCURRENTLY with that enrichment rather than after it, so
 * the two never queue behind one another; their relative order is not defined.
 *
 * @param {{apiClient:any,delivery:any,ref?:any,statusHandle:any,ctx:any,runId:string,url:string,actorId:string,pollIntervalMs?:number,maxMs?:number,logger?:any,formatOutcome:(run:any,url:string,actorId:string,decisionSummary?:any)=>any,onTerminal?:(run:any)=>Promise<void>}} args
 */
export async function watchRunUntilDone(args) {
	const interval = args.pollIntervalMs ?? 10_000;
	const deadline = Date.now() + (args.maxMs ?? 15 * 60_000);
	const formatOutcome = args.formatOutcome;
	while (Date.now() < deadline) {
		await new Promise((resolve) => {
			const timer = setTimeout(resolve, interval);
			timer.unref?.();
		});
		try {
			const run = await args.apiClient.getEvalRun(args.runId, args.ctx);
			if (TERMINAL_STATUSES.has(run.status)) {
				// THE VERDICT GOES OUT FIRST, unenriched.
				//
				// Reading the decision summary before this edit made the chain
				// sentence a PRECONDITION of the notification: a slow or degraded
				// route held somebody's "running…" message for up to the read's
				// full 30s timeout. That is the same trade the fail-soft rule
				// already refuses — an enrichment must never decide whether, or
				// when, the verdict arrives.
				const verdict = formatOutcome(run, args.url, args.actorId, null);
				await args.delivery.edit(args.statusHandle, verdict);
				// The enrichment and the completion follow-up are INDEPENDENT, so
				// they run concurrently — neither may gate the other. Sequencing
				// them put the summary read in front of `onTerminal`, and
				// `onTerminal` is where a surface uploads failure evidence: a
				// FAILED run is exactly the case that wants a chain line, so every
				// run with screenshots to post was also a run that waited up to
				// the read's full 30s before posting them. Moving the read off the
				// verdict's path and onto the evidence's path would not have been
				// a fix.
				await Promise.allSettled([
					enrichWithDecisionChain(args, run, verdict),
					runTerminalHook(args, run),
				]);
				return run;
			}
		} catch (error) {
			args.logger?.warn?.(`Run status poll failed: ${error}`);
		}
	}
	args.logger?.warn?.(
		`Run ${args.runId} did not reach a terminal status within the watch window.`,
	);
	return null;
}
