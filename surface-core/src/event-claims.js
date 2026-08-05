// @ts-nocheck
import { InstallationBackendError } from "./backend-client.js";

/** @param {{backend:any,surfaceKind:string}} options */
export function createEventClaims({ backend, surfaceKind }) {
	const key = (value) => `${surfaceKind}:${value}`;
	return {
		hasClaimBackend: () =>
			Boolean(
				process.env.MCPJAM_CONVEX_HTTP_URL &&
					(process.env[`MCPJAM_${surfaceKind.toUpperCase()}_SERVICE_TOKEN`] ||
						process.env[`${surfaceKind.toUpperCase()}_SERVICE_TOKEN`]),
			),
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
		completeEvent: (dedupeKey, envelope, opts) =>
			backend.completeEvent(key(dedupeKey), envelope, opts),
		releaseEvent: (dedupeKey, opts) =>
			backend.releaseEvent(key(dedupeKey), opts),
		key,
	};
}
