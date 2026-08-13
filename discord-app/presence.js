// @ts-nocheck
import { config } from "./config.js";

/** How long to wait on Convex before giving up. Presence is never worth a hang. */
const PRESENCE_TIMEOUT_MS = 5_000;

/**
 * Record that the bot was installed into, or removed from, a guild.
 *
 * BEST-EFFORT BY CONSTRUCTION. This is called from Gateway event handlers that
 * cannot await it usefully and have nowhere to report a failure, so it never
 * throws: a missing config, a network error, a timeout, and a non-2xx all
 * return `false`. The alternative — an unhandled rejection out of a
 * fire-and-forget call inside a Gateway handler — takes the whole process down
 * on a transient Convex blip, which is a strictly worse trade for a telemetry
 * write.
 *
 * The timeout matters as much as the try/catch: `fetch` with no signal waits
 * on the OS default, so a Convex deployment that accepts connections and then
 * stalls would leave these hanging for minutes with nothing to cancel them.
 */
export async function recordPresence({
	tenantId,
	status,
	fetchImpl = fetch,
} = {}) {
	const baseUrl = config.convexHttpUrl;
	// The CONVEX credential specifically — `/agent/*` does not accept the
	// Inspector's `dsc_` bearer. See config.js on why these never fall back to
	// one another.
	const token = config.convexServiceToken;
	if (!baseUrl || !token) return false;

	try {
		const response = await fetchImpl(`${baseUrl}/agent/presence`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-discord-service-token": token,
			},
			body: JSON.stringify({
				surfaceKind: "discord",
				surfaceTenantId: tenantId,
				status,
			}),
			signal: AbortSignal.timeout(PRESENCE_TIMEOUT_MS),
		});
		return response.ok;
	} catch (error) {
		console.warn(
			`[discord] presence ${status} for guild ${tenantId} failed: ${
				error?.message ?? error
			}`,
		);
		return false;
	}
}
