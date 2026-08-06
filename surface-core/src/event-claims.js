import { InstallationBackendError } from "./backend-client.js";

/**
 * Durable at-most-once delivery for one surface's events.
 *
 * THE KEY IS A CONTRACT, NOT A DETAIL. The same string is claimed here and sent
 * to the server as the turn's idempotency key, from which it derives a stable
 * key per write. Change the format and two things break at once: claims already
 * in flight stop matching across a deploy (the redelivery runs a second time),
 * and a retried turn's mutations author new rows instead of landing on the
 * first attempt's. So a surface that already has a key format in production
 * keeps it — `formatKey` exists to say so explicitly rather than to be
 * discovered later.
 *
 * @param {{
 *   backend: any,
 *   surfaceKind: string,
 *   formatKey?: (dedupeKey: string) => string,
 *   hasBackend?: () => boolean,
 * }} options
 */
export function createEventClaims({
	backend,
	surfaceKind,
	formatKey,
	hasBackend,
}) {
	// Namespacing by surface is the right DEFAULT for a new surface: two
	// products can mint the same tenant/event id pair and must not collide.
	const key =
		formatKey ?? ((/** @type {string} */ value) => `${surfaceKind}:${value}`);
	return {
		hasClaimBackend: () =>
			hasBackend
				? hasBackend()
				: Boolean(
						process.env.MCPJAM_CONVEX_HTTP_URL &&
							process.env[`${surfaceKind.toUpperCase()}_SERVICE_TOKEN`],
					),
		/** @param {string} dedupeKey @param {{fetchImpl?: typeof fetch}} [opts] */
		claimEvent: async (dedupeKey, opts) => {
			const result = await backend.claimEvent(key(dedupeKey), opts);
			if (
				!result ||
				!["claimed", "inflight", "completed"].includes(result.outcome)
			)
				throw new InstallationBackendError(
					"Claim backend returned an unknown outcome.",
				);
			return result;
		},
		/**
		 * @param {string} dedupeKey
		 * @param {unknown} envelope
		 * @param {{fetchImpl?: typeof fetch}} [opts]
		 * @returns {Promise<any>}
		 */
		completeEvent: (dedupeKey, envelope, opts) =>
			backend.completeEvent(key(dedupeKey), envelope, opts),
		/**
		 * @param {string} dedupeKey
		 * @param {{fetchImpl?: typeof fetch}} [opts]
		 * @returns {Promise<any>}
		 */
		releaseEvent: (dedupeKey, opts) =>
			backend.releaseEvent(key(dedupeKey), opts),
		key,
	};
}
