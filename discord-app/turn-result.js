// @ts-nocheck
import { textContent } from "@mcpjam/surface-core";

/**
 * Shape a live turn result so both delivery paths work from ONE object:
 *
 *   - live delivery (`delivery.deliver`) reads `.parts` (StructuredContent).
 *   - the core's persisted-claim contract (`normalizeResult`, in
 *     surface-core/src/turn-runner.js) reads ONLY `.reply` — a plain string
 *     — when storing this for replay. `.parts` never survives that trip.
 *
 * Omitting `.reply` here (returning StructuredContent alone) meant every
 * durable claim stored an EMPTY reply, so a redelivered event replayed
 * blank text — the exact bug this function exists to prevent.
 *
 * @param {{reply?: string, proposedActions?: any[]}} turnResult
 */
export function toDeliverableResult(turnResult) {
	return {
		reply: turnResult.reply || "",
		...textContent(turnResult.reply || "", "info"),
		proposedActions: turnResult.proposedActions || [],
	};
}

/**
 * Rebuild deliverable content from a PERSISTED envelope on replay.
 *
 * The stored envelope only ever carries `.reply` and `.proposedActions` —
 * see `toDeliverableResult` above for why `.parts` is never among them — so
 * this reconstructs the same shape a live turn produces, from what
 * actually survived storage.
 *
 * @param {{reply?: string, proposedActions?: any[]}} envelope
 */
export function toReplayContent(envelope) {
	return {
		...textContent(
			envelope.reply || "Done — though I have nothing to add.",
			"info",
		),
		proposedActions: envelope.proposedActions || [],
	};
}
