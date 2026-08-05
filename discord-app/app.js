import "dotenv/config";
import {
	Client,
	Events,
	GatewayIntentBits,
	REST,
	Routes,
	SlashCommandBuilder,
} from "discord.js";
import { createDiscordHandlers } from "./src/handlers.js";

if (process.env.MCPJAM_DISCORD_ENABLED !== "true") {
	throw new Error(
		'MCPJAM_DISCORD_ENABLED must be exactly "true" before the Discord app will accept traffic.',
	);
}
if (!process.env.DISCORD_BOT_TOKEN || !process.env.DISCORD_APPLICATION_ID)
	throw new Error("DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID are required.");
const botToken = process.env.DISCORD_BOT_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
	],
});
const handlers = createDiscordHandlers(client, {
	enabled: true,
	logger: {
		warn: (/** @type {string} */ message) =>
			process.stderr.write(`${message}\n`),
	},
});

client.once(Events.ClientReady, async (ready) => {
	const rest = new REST({ version: "10" }).setToken(botToken);
	await rest.put(Routes.applicationCommands(applicationId), {
		body: [
			new SlashCommandBuilder()
				.setName("mcpjam")
				.setDescription("MCPJam controls")
				.addSubcommand((command) =>
					command
						.setName("connect")
						.setDescription("Connect your MCPJam account"),
				)
				.toJSON(),
		],
	});
	for (const guild of ready.guilds.cache.values())
		await handlers.handleGuildCreate(guild);
});
client.on(Events.MessageCreate, handlers.handleMessage);
client.on(Events.InteractionCreate, handlers.handleInteraction);
client.on(Events.GuildCreate, handlers.handleGuildCreate);
client.on(Events.GuildDelete, handlers.handleGuildDelete);
await client.login(botToken);
