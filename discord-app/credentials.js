// @ts-nocheck
import { McpjamApiError } from "@mcpjam/surface-core";

const DEFAULT_BASE_URL = "https://app.mcpjam.com";

/** @param {string} value */
const trimOrigin = (value) => String(value || "").replace(/\/+$/, "");

/**
 * TWO NAMES, TWO JOBS — but, for now, ONE VALUE.
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
 *                                against MCPJAM_DISCORD_SERVICE_TOKEN_HASH.
 *
 * THEY MUST CURRENTLY HOLD THE SAME `dsc_` VALUE, and that is not a nicety of
 * configuration — it is forced by the server. The inspector does not terminate
 * the bot's bearer token: it FORWARDS it to Convex verbatim as
 * `x-discord-service-token`, on both legs.
 *
 *   /api/v1/*                    surface-service-auth.ts hands the bearer to
 *                                `resolveSurfaceActingUser(..., {surfaceServiceToken})`
 *   /api/surface-link/session    surface-link/index.ts hands it to
 *                                `createSurfaceLinkSession(args, token)`
 *
 * Both land in `slack-backend.ts`'s `post()`, which sets
 * `x-discord-service-token: <that same bearer>`. Convex then checks it against
 * ITS `DISCORD_SERVICE_TOKEN`. So the app API token has to satisfy the Convex
 * check too, which means one value seeded in three places — and it must carry
 * the `dsc_` prefix, because the /api/v1 hash check runs first.
 *
 * Splitting them for real needs a server change: the inspector→Convex hop has
 * to present its OWN Convex credential instead of relaying the caller's. These
 * accessors are the seam that makes that a configuration change rather than a
 * code change — every call site already asks for the token by JOB, so the day
 * the hop is fixed the two variables can diverge and nothing here moves.
 *
 * What this module does fix today is the mess it replaces: three different
 * precedence orders for "the token" across one file, one of which preferred the
 * Convex-shaped token for the connect-link mint — a route that rejects anything
 * without a `dsc_` prefix, so it could never have worked.
 */

/** The Convex service credential, or undefined when unset. */
export function convexServiceToken() {
	return process.env.DISCORD_SERVICE_TOKEN || undefined;
}

/** The app API credential, or undefined when unset. */
export function apiServiceToken() {
	return process.env.MCPJAM_DISCORD_SERVICE_TOKEN || undefined;
}

const API_TOKEN_PREFIX = "dsc_";

/**
 * The app API credential, or a NAMED config error.
 *
 * Callers that mint a connect link need the failure to say which variable is
 * wrong: the message is shown to an operator, and "Unable to create a connect
 * link: undefined" tells them nothing.
 *
 * The prefix is checked HERE as well as on the server. The server's check is
 * the one that matters for security, but it answers a bare "Invalid API key" —
 * so a token pasted from the wrong variable looks identical to a revoked one.
 * Failing locally names the variable and the expected shape instead.
 */
export function requireApiServiceToken() {
	const token = apiServiceToken();
	if (!token)
		throw new McpjamApiError(
			"MCPJAM_DISCORD_SERVICE_TOKEN must be set to reach the MCPJam API (see .env.sample).",
			{ code: "CONFIG" },
		);
	if (!token.startsWith(API_TOKEN_PREFIX))
		throw new McpjamApiError(
			`MCPJAM_DISCORD_SERVICE_TOKEN must start with "${API_TOKEN_PREFIX}" — the server rejects anything else before it checks the value (see .env.sample).`,
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
 * Origins a minted connect link is allowed to point at.
 *
 * Every entry is normalized, because the allowlist is compared against a
 * canonical `new URL(...).origin`, which never carries a trailing slash. An
 * unnormalized `MCPJAM_APP_URL=https://app.example.com/` therefore matches
 * nothing and makes the bot unlinkable — the variable looks right, the link
 * mints, and the check rejects it.
 *
 * Empty entries are dropped rather than defaulted, so an unset variable narrows
 * the allowlist instead of silently widening it. `trimOrigin(undefined)` is the
 * empty string, which is exactly what the filter removes.
 */
export function connectLinkOrigins() {
	return [
		trimOrigin(process.env.MCPJAM_APP_URL),
		trimOrigin(process.env.DISCORD_LINK_PUBLIC_ORIGIN),
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
