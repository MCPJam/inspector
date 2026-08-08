import { formatRunOutcome } from "./copy.js";

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
 * Polling is surface-neutral because the adapter owns the edit operation and
 * returns the exact status handle that can be edited.
 * @param {{apiClient:any,delivery:any,ref?:any,statusHandle:any,ctx:any,runId:string,url:string,actorId:string,pollIntervalMs?:number,maxMs?:number,logger?:any,formatOutcome?:(run:any,url:string,actorId:string)=>any,onTerminal?:(run:any)=>Promise<void>}} args
 */
export async function watchRunUntilDone(args) {
	const interval = args.pollIntervalMs ?? 10_000;
	const deadline = Date.now() + (args.maxMs ?? 15 * 60_000);
	const formatOutcome = args.formatOutcome ?? formatRunOutcome;
	while (Date.now() < deadline) {
		await new Promise((resolve) => {
			const timer = setTimeout(resolve, interval);
			timer.unref?.();
		});
		try {
			const run = await args.apiClient.getEvalRun(args.runId, args.ctx);
			if (TERMINAL_STATUSES.has(run.status)) {
				await args.delivery.edit(
					args.statusHandle,
					formatOutcome(run, args.url, args.actorId),
				);
				try {
					await args.onTerminal?.(run);
				} catch (error) {
					args.logger?.warn?.(`Run completion follow-up failed: ${error}`);
				}
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
