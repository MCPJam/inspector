/**
 * Watching a JOURNEY run to completion (the Swarms product).
 *
 * A separate module from `run-watcher.js`, not a parameter on it. The two look
 * alike from a distance and disagree on every detail that decides what a
 * surface tells someone:
 *
 *   - STATUS VOCABULARY. Eval runs are completed/failed/cancelled/timed_out.
 *     Journey runs are completed/partial/failed/rate_limited — and `partial`
 *     has no eval equivalent at all.
 *   - CANCELLATION IS NOT A STATUS. A journey run someone stopped comes back
 *     `status: "failed"` with `canceled: true`, because the backend
 *     deliberately did not add a status literal for it. A watcher reading
 *     status alone reports a deliberate stop as a failure, to the person who
 *     stopped it.
 *   - THE VERDICT IS IN THE SUMMARY, NOT THE STATUS. A run can be `completed`
 *     with most of its sessions failed. Eval runs carry a `result` field that
 *     says so; journey runs make you read `summary.{succeeded,failed,
 *     rateLimited}`.
 *   - EVIDENCE IS SESSIONS AND A SCORECARD, not iterations, steps and
 *     screenshots. There is no per-step trace to attach.
 *
 * Merging them would mean a function whose every branch asked "which kind is
 * this", which is the same thing as two functions with extra ceremony — and
 * the failure mode of getting it wrong is reporting a rate-limited fan-out as
 * a pass.
 */

/**
 * Statuses a journey run does not leave.
 *
 * `rate_limited` is terminal even though it reads like a retryable condition:
 * the run is over, it stopped because the org ran out of model capacity, and
 * waiting will not resume it. Treating it as in-flight would leave a status
 * message polling until the watch window expired and then reporting "still
 * running" about something that stopped an hour ago.
 */
export const JOURNEY_TERMINAL_STATUSES = new Set([
	"completed",
	"partial",
	"failed",
	"rate_limited",
]);

/**
 * What actually happened, as a surface should describe it.
 *
 * Returns a discriminated outcome rather than a boolean, because "did it fail"
 * is not a question with a useful yes/no answer here — a run where 8 of 10
 * sessions succeeded is neither a pass nor a failure, and forcing it into one
 * loses the number that matters.
 *
 * @param {{status?: string, canceled?: boolean, stale?: boolean, summary?: {total?: number, succeeded?: number, failed?: number, rateLimited?: number}}} run
 * @returns {{kind: "stopped"|"stalled"|"passed"|"partial"|"failed"|"rate_limited"|"unknown", succeeded: number, failed: number, rateLimited: number, total: number}}
 */
export function journeyRunOutcome(run) {
	const summary = run?.summary ?? {};
	const succeeded = Number(summary.succeeded ?? 0);
	const failed = Number(summary.failed ?? 0);
	const rateLimited = Number(summary.rateLimited ?? 0);
	const total = Number(summary.total ?? succeeded + failed + rateLimited);
	const counts = { succeeded, failed, rateLimited, total };

	// CANCELLATION FIRST, before status. A stopped run arrives as `failed`, and
	// telling the person who pressed Stop that their run failed is both wrong
	// and the kind of wrong that makes them go looking for a bug.
	if (run?.canceled === true) return { kind: "stopped", ...counts };
	// Likewise a run whose runner went silent: it did not fail on its merits,
	// and "the runner stopped reporting" is what someone needs to hear to know
	// the results are incomplete rather than bad.
	if (run?.stale === true) return { kind: "stalled", ...counts };

	if (run?.status === "rate_limited")
		return { kind: "rate_limited", ...counts };
	if (run?.status === "failed") return { kind: "failed", ...counts };
	if (run?.status === "partial") return { kind: "partial", ...counts };
	if (run?.status === "completed") {
		// A completed run with failures is still a completed run — but calling
		// it "passed" would put a green verdict on a fan-out where most sessions
		// did not reach their goal.
		if (failed > 0 || rateLimited > 0) return { kind: "partial", ...counts };
		return { kind: "passed", ...counts };
	}
	return { kind: "unknown", ...counts };
}

/**
 * Whether an outcome warrants attaching evidence.
 *
 * Evidence under a green verdict is noise; a red verdict with no evidence
 * makes whoever approved the spend go and dig it out themselves. `stopped` is
 * excluded deliberately — nothing went wrong, someone decided to stop.
 *
 * @param {{kind: string}} outcome
 */
export function journeyOutcomeWantsEvidence(outcome) {
	return (
		outcome?.kind === "failed" ||
		outcome?.kind === "partial" ||
		outcome?.kind === "rate_limited" ||
		outcome?.kind === "stalled"
	);
}

/**
 * Evidence for a journey run: its scorecard, and the sessions most worth
 * looking at.
 *
 * The SCORECARD LEADS, and that ordering is the useful part. It is
 * deterministic, small, and usually the whole answer — "the `checkout
 * completed` criterion failed 7 of 8 times" ends most investigations. Sessions
 * are the fallback for when the counts do not explain themselves.
 *
 * Both reads are optional: a run with no rubric has no scorecard (the route
 * 404s), and a run that died early may have no sessions. Neither is an error,
 * and a watcher that threw on them would turn a missing nicety into a failed
 * status update.
 *
 * @param {{apiClient:any, ctx:any, runId:string, limit?:number, logger?:any}} args
 * @returns {Promise<{scorecard: any|null, sessions: Array<Record<string, any>>}>}
 */
export async function collectJourneyRunEvidence(args) {
	const limit = args.limit ?? 5;
	/** @type {any} */
	let scorecard = null;
	/** @type {Array<Record<string, any>>} */
	let sessions = [];

	try {
		scorecard = await args.apiClient.getJourneyRunScorecard(
			args.runId,
			args.ctx,
		);
	} catch (error) {
		// A 404 here is the ordinary "this run had no rubric" case, so this is
		// logged at debug rather than warn — a warning per run for an expected
		// shape trains people to ignore the log.
		args.logger?.debug?.(
			`No scorecard for journey run ${args.runId}: ${error}`,
		);
	}

	try {
		const page = await args.apiClient.listJourneyRunSessions(
			args.runId,
			args.ctx,
			{ limit },
		);
		// FAILED SESSIONS FIRST. A run's first N sessions are whichever started
		// first, which correlates with nothing; the ones worth reading are the
		// ones that did not reach the goal.
		sessions = [...page].sort((left, right) => {
			const leftFailed = isFailedSession(left) ? 0 : 1;
			const rightFailed = isFailedSession(right) ? 0 : 1;
			return leftFailed - rightFailed;
		});
	} catch (error) {
		args.logger?.warn?.(
			`Journey run ${args.runId} session listing failed: ${error}`,
		);
	}

	return { scorecard, sessions: sessions.slice(0, limit) };
}

/** @param {Record<string, any>} session */
function isFailedSession(session) {
	if (session?.status === "failed") return true;
	// `goalScore` is the judge's verdict; `readiness` is the transport-level
	// one. Either being negative is enough to make a session interesting.
	const goalPassed = session?.goalScore?.passed;
	return goalPassed === false;
}

/**
 * Poll a journey run until it settles, then hand the surface its outcome.
 *
 * Surface-neutral in the same way `watchRunUntilDone` is: the adapter owns the
 * edit operation and the copy, and this owns only "when is it over and what
 * does over mean".
 *
 * THE WATCH WINDOW IS AN HOUR, not the eval watcher's fifteen minutes. A fan-out
 * across four environments at ten sessions each is forty conversations, and
 * fifteen minutes would time out on the ordinary case — reporting "still
 * running" about a run that was always going to take longer than that, which
 * is the least useful thing a status message can say.
 *
 * On timeout it returns null and the adapter is expected to say the run is
 * still going. It does NOT report a failure: nothing failed, we stopped
 * watching.
 *
 * @param {{apiClient:any,delivery:any,statusHandle:any,ctx:any,runId:string,url:string,actorId:string,pollIntervalMs?:number,maxMs?:number,logger?:any,formatOutcome:(run:any,outcome:any,url:string,actorId:string)=>any,onTerminal?:(run:any,outcome:any)=>Promise<void>}} args
 */
export async function watchJourneyRunUntilDone(args) {
	const interval = args.pollIntervalMs ?? 15_000;
	const deadline = Date.now() + (args.maxMs ?? 60 * 60_000);
	const formatOutcome = args.formatOutcome;

	while (Date.now() < deadline) {
		await new Promise((resolve) => {
			const timer = setTimeout(resolve, interval);
			timer.unref?.();
		});
		try {
			const run = await args.apiClient.getJourneyRun(args.runId, args.ctx);
			if (!JOURNEY_TERMINAL_STATUSES.has(run?.status)) continue;

			const outcome = journeyRunOutcome(run);
			await args.delivery.edit(
				args.statusHandle,
				formatOutcome(run, outcome, args.url, args.actorId),
			);
			try {
				await args.onTerminal?.(run, outcome);
			} catch (error) {
				// The follow-up is evidence and side effects. Failing it must not
				// make the run look unfinished — the status message is already
				// correct at this point.
				args.logger?.warn?.(`Journey run follow-up failed: ${error}`);
			}
			return run;
		} catch (error) {
			args.logger?.warn?.(`Journey run status poll failed: ${error}`);
		}
	}

	args.logger?.warn?.(
		`Journey run ${args.runId} did not settle within the watch window.`,
	);
	return null;
}
