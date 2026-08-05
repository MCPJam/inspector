// @ts-nocheck
import {
	fetchRunEvidence,
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
		onTerminal: async () => {
			const images = (
				await fetchRunEvidence({ apiClient, runId, ctx, limit: 5 })
			).map((image) => ({
				attachment: image.url,
				name: `${image.label.toLowerCase().replace(/\s+/g, "-")}.png`,
			}));
			if (images.length && surfaceDelivery?.uploadImages)
				await surfaceDelivery.uploadImages(ctx, images);
		},
		delivery: {
			edit: (messageHandle, content) =>
				messageHandle.message.edit({
					content: plainText(content),
					allowedMentions: { parse: [] },
				}),
		},
	});
}
