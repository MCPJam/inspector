// @ts-nocheck
import "dotenv/config";

/**
 * Every environment variable this app reads, resolved ONCE at boot.
 *
 * It exists because the same credential question was answered three different
 * ways in three places. `app.js` had:
 *
 *   MCPJAM_DISCORD_SERVICE_TOKEN || DISCORD_SERVICE_TOKEN || DISCORD_API_TOKEN
 *   DISCORD_SERVICE_TOKEN || MCPJAM_DISCORD_SERVICE_TOKEN || DISCORD_API_TOKEN
 *   DISCORD_SERVICE_TOKEN            (alone, on the unlinked-user path)
 *
 * Three orders, one of them reversed, plus a `DISCORD_API_TOKEN` fallback
 * nothing documents. On a deployment with both variables set they resolve to
 * DIFFERENT tokens depending on which line runs, and the failure is a 401 far
 * from the cause.
 *
 * ── THE TWO CREDENTIALS ARE NOT INTERCHANGEABLE ─────────────────────────────
 *
 * They authenticate to different services, and the fallback chains above were
 * quietly papering over that:
 *
 *   `convexServiceToken` (DISCORD_SERVICE_TOKEN)
 *       The Convex backend's `/agent/*` surface — event claims, thread
 *       bindings, presence. Sent as the `x-discord-service-token` header.
 *
 *   `inspectorApiToken` (MCPJAM_DISCORD_SERVICE_TOKEN)
 *       The Inspector's `/api/v1` and `/api/surface-link/session`. A `dsc_`
 *       bearer, matched against `MCPJAM_DISCORD_SERVICE_TOKEN_HASH` by
 *       `middleware/surface-service-auth.ts`.
 *
 * This mirrors the Slack app's split, which is deliberate for the same reason:
 * two services, two trust boundaries, two rotations. Handing one service the
 * other's token is not a degraded mode, it is an authentication failure — so
 * there is no cross-fallback here. A missing one is reported as missing.
 *
 * Reading at boot rather than per call is what makes that legible: the shape
 * of what this app needs is one object, in one file, instead of thirty
 * `process.env` reads whose disagreements only show up at runtime.
 */

const DEFAULT_APP_ORIGIN = "https://app.mcpjam.com";

function trimmed(value) {
	const text = typeof value === "string" ? value.trim() : "";
	return text.length > 0 ? text : undefined;
}

/**
 * Origins a connect link may point at.
 *
 * Deduped and order-preserving. `assertConnectUrl` normalizes each through
 * `new URL(x).origin` and skips anything malformed, so a typo here narrows the
 * allowlist rather than widening it — the safe direction for a list that
 * decides where a credential-bearing link may lead.
 */
function resolveLinkOrigins(env, baseUrl) {
	const candidates = [
		env.MCPJAM_APP_URL,
		env.DISCORD_LINK_PUBLIC_ORIGIN,
		baseUrl,
	];
	const origins = [];
	for (const candidate of candidates) {
		const value = trimmed(candidate);
		if (value && !origins.includes(value)) origins.push(value);
	}
	return origins;
}

/** @param {NodeJS.ProcessEnv} env */
export function loadConfig(env = process.env) {
	const baseUrl = trimmed(env.MCPJAM_BASE_URL) ?? DEFAULT_APP_ORIGIN;

	return {
		/** Gateway credential. The one thing with no sensible default. */
		botToken: trimmed(env.DISCORD_BOT_TOKEN),

		/**
		 * The agent turn is OFF unless this is explicitly "true". A Discord bot
		 * that answers when it should not is worse than one that stays quiet,
		 * and this app can be deployed before the agent is meant to be live.
		 */
		botEnabled: env.POSTHOG_DISCORD_AGENT_ENABLED === "true",

		/** Convex `/agent/*` — claims, thread bindings, presence. */
		convexServiceToken: trimmed(env.DISCORD_SERVICE_TOKEN),
		/** Inspector `/api/v1` + `/api/surface-link/session`. A `dsc_` bearer. */
		inspectorApiToken: trimmed(env.MCPJAM_DISCORD_SERVICE_TOKEN),

		/** Inspector base URL. Where turns and connect links go. */
		baseUrl,
		/** Public app URL, for links shown to a human. */
		appUrl: trimmed(env.MCPJAM_APP_URL) ?? DEFAULT_APP_ORIGIN,
		/** Convex HTTP URL, for presence. Absent ⇒ presence is a no-op. */
		convexHttpUrl: trimmed(env.MCPJAM_CONVEX_HTTP_URL)?.replace(/\/+$/, ""),

		linkOrigins: resolveLinkOrigins(env, baseUrl),

		/**
		 * LEGACY single-project fallback, for a deployment predating per-user
		 * linking. Real installs resolve the project from the linked account, so
		 * this is only consulted when nothing else answers.
		 */
		legacyProjectId: trimmed(env.MCPJAM_PROJECT_ID),

		/** Slash-command registration. Both required, or registration is skipped. */
		applicationId: trimmed(env.DISCORD_APPLICATION_ID),
		guildId: trimmed(env.DISCORD_GUILD_ID),
	};
}

/**
 * The boot-time check.
 *
 * Only `botToken` is fatal — without it there is no bot at all. Everything
 * else degrades to a describable state (no agent, no presence, no connect
 * links) and is WARNED about rather than thrown on, so a partially-provisioned
 * deployment starts and tells you what it cannot do instead of crash-looping
 * with one line of stack.
 *
 * @returns {string[]} warnings, empty when fully configured
 */
export function describeConfigGaps(config) {
	const warnings = [];
	if (!config.convexServiceToken) {
		warnings.push(
			"DISCORD_SERVICE_TOKEN is not set — event claims, thread bindings and presence are disabled. (This is the CONVEX credential; it is not interchangeable with MCPJAM_DISCORD_SERVICE_TOKEN.)",
		);
	}
	if (!config.inspectorApiToken) {
		warnings.push(
			"MCPJAM_DISCORD_SERVICE_TOKEN is not set — agent turns and connect links will be rejected by the Inspector. (This is the INSPECTOR credential; it is not interchangeable with DISCORD_SERVICE_TOKEN.)",
		);
	}
	if (!config.convexHttpUrl) {
		warnings.push(
			"MCPJAM_CONVEX_HTTP_URL is not set — install/uninstall presence will not be recorded.",
		);
	}
	if (!config.botEnabled) {
		warnings.push(
			'POSTHOG_DISCORD_AGENT_ENABLED is not "true" — the bot will connect but will not answer mentions.',
		);
	}
	return warnings;
}

export const config = loadConfig();
