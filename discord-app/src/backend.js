// @ts-nocheck
import {
	createApiClient,
	createBackendClient,
	createEventClaims,
	McpjamApiError,
} from "@mcpjam/surface-core";

export const backend = createBackendClient({
	surfaceKind: "discord",
	serviceTokenEnv: "MCPJAM_DISCORD_SERVICE_TOKEN",
	routePrefix: "/agent",
	authHeaderName: "x-discord-service-token",
});
export const eventClaims = createEventClaims({
	backend,
	surfaceKind: "discord",
});
export const apiClient = createApiClient({
	routePrefix: "/agent",
	conversationField: "conversationId",
	identityHeaders: (ctx) => ({
		"x-mcpjam-surface-tenant-id": ctx.tenantId,
		"x-mcpjam-surface-actor-id": ctx.actorId,
	}),
	getConfig: (ctx, overrides = {}) => {
		if (!ctx?.tenantId || !ctx?.actorId)
			throw new McpjamApiError("Discord identity is required.", {
				code: "CONFIG",
			});
		const apiKey =
			overrides.apiKey ||
			process.env.MCPJAM_DISCORD_SERVICE_TOKEN ||
			process.env.DISCORD_SERVICE_TOKEN;
		const projectId = overrides.projectId || ctx.projectId;
		if (!apiKey || !projectId)
			throw new McpjamApiError(
				!apiKey
					? "Discord service credentials are missing."
					: "A Discord turn needs a project.",
				{ code: !apiKey ? "CONFIG" : "NO_PROJECT" },
			);
		const baseUrl = String(
			overrides.baseUrl ||
				process.env.MCPJAM_BASE_URL ||
				"https://app.mcpjam.com",
		).replace(/\/+$/, "");
		const appUrl = String(
			overrides.appUrl || process.env.MCPJAM_APP_URL || baseUrl,
		).replace(/\/+$/, "");
		return {
			apiKey,
			projectId,
			baseUrl,
			appUrl,
			headers: {
				"x-mcpjam-surface-tenant-id": String(ctx.tenantId),
				"x-mcpjam-surface-actor-id": String(ctx.actorId),
			},
			routePrefix: "/agent",
		};
	},
});

/** Mint a short-lived, Discord-bound account-link URL through the inspector. */
export async function mintConnectUrl(ctx, opts = {}) {
	const baseUrl = String(
		opts.baseUrl || process.env.MCPJAM_BASE_URL || "https://app.mcpjam.com",
	).replace(/\/+$/, "");
	const token =
		opts.serviceToken ||
		process.env.MCPJAM_DISCORD_SERVICE_TOKEN ||
		process.env.DISCORD_SERVICE_TOKEN;
	if (!token)
		throw new McpjamApiError("Discord service credentials are missing.", {
			code: "CONFIG",
		});
	const response = await (opts.fetchImpl || fetch)(
		`${baseUrl}/api/surface-link/session`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				surfaceKind: "discord",
				surfaceTenantId: ctx.tenantId,
				surfaceUserId: ctx.actorId,
			}),
		},
	);
	const payload = await response.json().catch(() => null);
	if (!response.ok || typeof payload?.url !== "string")
		throw new McpjamApiError(
			payload?.message || "Could not mint a Discord connect URL.",
			{
				status: response.status,
				code: payload?.code || "CONNECT_FAILED",
			},
		);
	return payload.url;
}
