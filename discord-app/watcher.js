// @ts-nocheck
import {
	collectJourneyRunEvidence,
	fetchRunEvidence,
	formatJourneyRunEvidenceLines,
	formatJourneyRunOutcome,
	formatRunOutcome,
	isFailedOutcome,
	journeyOutcomeWantsEvidence,
	plainText,
	watchJourneyRunUntilDone,
	watchRunUntilDone,
} from "@mcpjam/surface-core";

/** Watcher deliberately edits a bot-authored message by id; no interaction
 * token or 15-minute window is involved for Gateway turns. */
export function watchDiscordRun({
	apiClient,
	ctx,
	runId,
	handle,
	surfaceDelivery = null,
	url = "",
	actorId = "",
	intervalMs = 10_000,
	maxMs = 15 * 60_000,
	logger = console,
}) {
	return watchRunUntilDone({
		apiClient,
		ctx,
		runId,
		url,
		actorId,
		statusHandle: handle,
		pollIntervalMs: intervalMs,
		maxMs,
		onTerminal: async (run) => {
			// EVIDENCE ONLY ON FAILURE, matching Slack. Screenshots under a green
			// "run passed" are noise; the shared predicate also catches the shape
			// this used to miss entirely — a run that COMPLETED with
			// `result: "failed"`, which a `status`-only check reads as a success.
			// (This path was ungated, so it uploaded evidence for passing runs.)
			if (!isFailedOutcome(run)) return;
			// BYTES, not urls. Handing discord.js the artifact url would let it do
			// the fetch, skipping the core's https-only check, its refusal to
			// follow redirects, and its 8 MB incremental cap.
			const images = (
				await fetchRunEvidence({ apiClient, runId, ctx, limit: 5, logger })
			).map((image) => ({
				attachment: image.bytes,
				name: image.filename,
				description: image.caption,
			}));
			if (images.length && surfaceDelivery?.uploadImages)
				await surfaceDelivery.uploadImages(ctx, images);
		},
		// The generic copy, not a Discord-specific one — matches what the core
		// used to default to. `delivery.edit` stringifies it below either way.
		formatOutcome: formatRunOutcome,
		delivery: {
			edit: (messageHandle, content) =>
				messageHandle.message.edit({
					content: plainText(content),
					allowedMentions: { parse: [] },
				}),
		},
	});
}

/**
 * Watch a JOURNEY (Swarms) run — the sibling of `watchDiscordRun`, kept
 * separate for the same reason the core keeps two watchers: different status
 * vocabulary, cancellation that is not a status, and a verdict that lives in
 * the summary. Routing a journey run through the eval watcher reports a
 * rate-limited fan-out as a pass.
 *
 * Evidence is TEXT — the scorecard and the worst sessions — not screenshots:
 * a journey run has no per-step trace to attach. Posted only for outcomes
 * whose message says something broke (`journeyOutcomeWantsEvidence`); counts
 * under a green verdict are noise. Delivered as a NEW message via
 * `surfaceDelivery.deliver`, never an edit — the outcome line must survive.
 */
export function watchDiscordJourneyRun({
	apiClient,
	ctx,
	runId,
	handle,
	surfaceDelivery = null,
	url = "",
	actorId = "",
	intervalMs = 15_000,
	// An hour, not the eval watcher's fifteen minutes: a multi-environment
	// fan-out ordinarily outlives a short window, and timing out on the
	// ordinary case makes the status message say the least useful thing.
	maxMs = 60 * 60_000,
	logger = console,
}) {
	return (async () => {
		const run = await watchJourneyRunUntilDone({
			apiClient,
			ctx,
			runId,
			url,
			actorId,
			statusHandle: handle,
			pollIntervalMs: intervalMs,
			maxMs,
			logger,
			formatOutcome: formatJourneyRunOutcome,
			onTerminal: async (_run, outcome) => {
				if (!journeyOutcomeWantsEvidence(outcome)) return;
				if (!surfaceDelivery?.deliver) return;
				const evidence = await collectJourneyRunEvidence({
					apiClient,
					ctx,
					runId,
					limit: 5,
					logger,
				});
				const lines = formatJourneyRunEvidenceLines(evidence, {
					maxSessions: 5,
				});
				if (lines.length === 0) return;
				await surfaceDelivery.deliver(ctx, {
					severity: "info",
					code: "journey_run_evidence",
					parts: [lines.join("\n")],
				});
			},
			delivery: {
				edit: (messageHandle, content) =>
					messageHandle.message.edit({
						content: plainText(content),
						allowedMentions: { parse: [] },
					}),
			},
		});
		// Null means the WATCH WINDOW expired, not the run — say so instead of
		// leaving "running…" to read as a hang or a silent bot.
		if (run === null) {
			try {
				await handle.message.edit({
					content: plainText({
						severity: "info",
						code: "journey_run_still_running",
						parts: [
							`Swarm run is still going after an hour${url ? ` — follow the rest at ${url}` : ""}.`,
						],
					}),
					allowedMentions: { parse: [] },
				});
			} catch (error) {
				logger?.warn?.(
					`Journey run ${runId} still-running edit failed: ${error}`,
				);
			}
		}
		return run;
	})();
}
