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
		onTerminal: async () => {
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
		delivery: {
			edit: (messageHandle, content) =>
				messageHandle.message.edit({
					content: plainText(content),
					allowedMentions: { parse: [] },
				}),
		},
	});
}
