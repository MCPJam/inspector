// @ts-nocheck
import {
	fetchRunEvidence,
	formatRunOutcome,
	isFailedOutcome,
	plainText,
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
