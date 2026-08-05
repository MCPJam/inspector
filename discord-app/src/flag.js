/**
 * Production traffic is opt-in. The strict boolean check is intentional: a
 * missing, malformed, or differently-cased flag must keep the listener off.
 * @param {unknown} [value]
 */
export function discordEnabled(
	value = process.env.MCPJAM_DISCORD_ENABLED === "true",
) {
	return value === true;
}
