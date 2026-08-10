// @ts-nocheck
import { Routes, SlashCommandBuilder } from "discord.js";

/**
 * The bot's slash commands, as the wire payload Discord expects.
 *
 * `.toJSON()` rather than the builder itself: `rest.put` would serialize the
 * builder identically (JSON.stringify calls toJSON), but naming the shape
 * here makes it something a test can assert on without standing up a REST
 * client.
 */
export const MCPJAM_COMMANDS = [
	new SlashCommandBuilder()
		.setName("mcpjam")
		.setDescription("MCPJam commands")
		.addSubcommand((subcommand) =>
			subcommand.setName("connect").setDescription("Connect MCPJam"),
		)
		.toJSON(),
];

/**
 * WHERE to register the commands — the difference between a bot that works
 * in one server and a bot that works in every server it is added to.
 *
 * GUILD-scoped registration reaches exactly one server and propagates
 * instantly. GLOBAL registration reaches every server the bot is in, but
 * Discord may take up to an hour to propagate it.
 *
 * So `devGuildId`, when set, is a DEVELOPMENT override: it buys instant
 * iteration in a test server. Its absence is the production case, and
 * before this it meant registration was skipped ENTIRELY — a bot added to a
 * second server had no `/mcpjam` command at all, only the @-mention path.
 * That is why global is the fallback rather than the other way around:
 * getting the command into every server matters more than the propagation
 * delay, and a developer who wants instant feedback opts in.
 *
 * Global is also the only option that SCALES: it is one API call regardless
 * of how many servers the bot is in, where per-guild registration would be
 * one call per server at startup plus one per join, each rate-limited.
 *
 * THE PARAMETER IS DELIBERATELY NOT THE OLD `DISCORD_GUILD_ID`. Registration
 * used to require a guild id, so every deployment with a working `/mcpjam`
 * — production included — has that variable set. Honouring it here would
 * leave exactly those deployments guild-scoped after the upgrade, making
 * this change a no-op precisely where it is needed. The caller passes
 * `DISCORD_DEV_GUILD_ID`, a name no existing deployment has, so the new
 * behavior is the default on deploy rather than something an operator has
 * to remember to unset.
 *
 * `applicationId` is required either way — it addresses the application
 * whose commands these are, and without it there is nothing to register
 * against.
 *
 * @param {{applicationId?: string, devGuildId?: string}} options
 * @returns {{scope: "guild"|"global"|"skipped", route?: string}}
 */
export function resolveCommandRegistration({ applicationId, devGuildId } = {}) {
	if (!applicationId) return { scope: "skipped" };
	if (devGuildId)
		return {
			scope: "guild",
			route: Routes.applicationGuildCommands(applicationId, devGuildId),
		};
	return { scope: "global", route: Routes.applicationCommands(applicationId) };
}
