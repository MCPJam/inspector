// @ts-nocheck
import { McpjamApiError } from "@mcpjam/surface-core";

const DEFAULT_BASE_URL = "https://app.mcpjam.com";

/** @param {string} value */
const trimOrigin = (value) => String(value || "").replace(/\/+$/, "");

/**
 * TWO SECRETS, TWO JOBS. They are not interchangeable and must never fall back
 * to one another — a single value doing both jobs is exactly the coupling
 * slack-app's .env.sample forbids, because it widens the blast radius of either
 * secret leaking to both surfaces of the system.
 *
 *   DISCORD_SERVICE_TOKEN        the CONVEX service credential. Presented as
 *                                the `x-discord-service-token` header to the
 *                                `/agent/*` routes (bindings, links, claims,
 *                                presence). Verified against the Convex
 *                                deployment's own configured token.
 *
 *   MCPJAM_DISCORD_SERVICE_TOKEN the APP API credential. Presented as
 *                                `Authorization: Bearer` to `/api/v1/*` and
 *                                `/api/surface-link/session`. The server
 *                                requires a `dsc_` prefix and hash-matches it
 *                                against MCPJAM_DISCORD_SERVICE_TOKEN_HASH, so
 *                                handing it the Convex token cannot work — it
 *                                fails the prefix check before anything else.
 *
 * The old code had three different precedence orders for "the token" across one
 * file, and the only configuration that worked was one secret doing both jobs.
 * These accessors exist so there is exactly one answer per job, named.
 */

/** The Convex service credential, or undefined when unset. */
export function convexServiceToken() {
	return process.env.DISCORD_SERVICE_TOKEN || undefined;
}

/** The app API credential, or undefined when unset. */
export function apiServiceToken() {
	return process.env.MCPJAM_DISCORD_SERVICE_TOKEN || undefined;
}

/**
 * The app API credential, or a NAMED config error.
 *
 * Callers that mint a connect link need the failure to say which variable is
 * missing: the message is shown to an operator, and "Unable to create a connect
 * link: undefined" tells them nothing.
 */
export function requireApiServiceToken() {
	const token = apiServiceToken();
	if (!token)
		throw new McpjamApiError(
			"MCPJAM_DISCORD_SERVICE_TOKEN must be set to reach the MCPJam API (see .env.sample).",
			{ code: "CONFIG" },
		);
	return token;
}

export function baseUrl() {
	return trimOrigin(process.env.MCPJAM_BASE_URL || DEFAULT_BASE_URL);
}

/**
 * Deep links can point somewhere other than the API host — in local dev the API
 * is on one port while the app UI is served on another.
 */
export function appUrl() {
	return trimOrigin(process.env.MCPJAM_APP_URL || baseUrl());
}

/**
 * Origins a minted connect link is allowed to point at. Empty entries are
 * dropped rather than defaulted, so an unset variable narrows the allowlist
 * instead of silently widening it.
 */
export function connectLinkOrigins() {
	return [
		process.env.MCPJAM_APP_URL,
		process.env.DISCORD_LINK_PUBLIC_ORIGIN,
		baseUrl(),
	].filter(Boolean);
}

/**
 * The credential seam for the API client: the last point before a secret is
 * handed out, so every guard is re-asserted HERE rather than trusted from the
 * call path.
 *
 * The guards are the point. Without them a turn with no resolved project builds
 * `/projects/undefined/...` and a turn with no token sends `Bearer undefined`,
 * and both fail as an opaque 401 from the server instead of a named config
 * error naming the variable an operator has to set.
 *
 * @param {any} ctx
 * @param {{apiKey?:string, projectId?:string, baseUrl?:string, appUrl?:string}} [overrides]
 */
export function getConfig(ctx, overrides = {}) {
	if (!ctx?.tenantId || !ctx?.actorId)
		throw new McpjamApiError(
			"MCPJam credentials were requested without a Discord tenant context.",
			{ code: "CONFIG" },
		);
	const apiKey = overrides.apiKey || apiServiceToken();
	const projectId = overrides.projectId || ctx.projectId;
	if (!apiKey)
		throw new McpjamApiError(
			"MCPJAM_DISCORD_SERVICE_TOKEN must be set to reach the MCPJam API (see .env.sample).",
			{ code: "CONFIG" },
		);
	if (!projectId)
		throw new McpjamApiError("No project resolved for this turn.", {
			code: "NO_PROJECT",
		});
	return {
		apiKey,
		projectId,
		baseUrl: trimOrigin(overrides.baseUrl || baseUrl()),
		appUrl: trimOrigin(overrides.appUrl || appUrl()),
		// The identity. Without both, the server has no user to act as and
		// answers 401 — which is the correct outcome, not a fallback.
		headers: {
			"x-mcpjam-surface-tenant-id": String(ctx.tenantId),
			"x-mcpjam-surface-actor-id": String(ctx.actorId),
		},
		routePrefix: "/agent",
	};
}
