// @ts-nocheck
export async function recordPresence({
	tenantId,
	status,
	fetchImpl = fetch,
} = {}) {
	const baseUrl = (process.env.MCPJAM_CONVEX_HTTP_URL || "").replace(
		/\/+$/,
		"",
	);
	const token = process.env.DISCORD_SERVICE_TOKEN;
	if (!baseUrl || !token) return false;
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
	});
	return response.ok;
}
