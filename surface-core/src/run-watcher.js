// @ts-nocheck
import { formatRunOutcome } from "./copy.js";

export const TERMINAL_STATUSES = new Set([
	"completed",
	"failed",
	"cancelled",
	"timed_out",
]);

/**
 * Polling is surface-neutral because the adapter owns the edit operation and
 * returns the exact status handle that can be edited.
 * @param {{apiClient:any,delivery:any,ref:any,statusHandle:any,ctx:any,runId:string,url:string,actorId:string,pollIntervalMs?:number,maxMs?:number,logger?:any}} args
 */
export async function watchRunUntilDone(args) {
	const interval = args.pollIntervalMs ?? 10_000;
	const deadline = Date.now() + (args.maxMs ?? 15 * 60_000);
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
					formatRunOutcome(run, args.url, args.actorId),
				);
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
