// @ts-nocheck
import "dotenv/config";
import {
	createApiClient,
	createBackendClient,
	createEventClaims,
	createTurnTargetResolver,
	mintConnectUrl,
	runTurn,
	textContent,
} from "@mcpjam/surface-core";
import {
	Client,
	Events,
	GatewayIntentBits,
	Partials,
	REST,
	Routes,
	SlashCommandBuilder,
} from "discord.js";
import {
	deriveConversationIdentity,
	ensureThreadBinding,
} from "./conversation.js";
import {
	baseUrl,
	connectLinkOrigins,
	convexServiceToken,
	getConfig,
	requireApiServiceToken,
} from "./credentials.js";
import { createDiscordDelivery } from "./delivery.js";
import { fetchHistory } from "./history.js";
import { recordPresence } from "./presence.js";
import { watchDiscordRun } from "./watcher.js";

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) throw new Error("DISCORD_BOT_TOKEN is required");
const botEnabled = process.env.POSTHOG_DISCORD_AGENT_ENABLED === "true";
const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
	],
	partials: [Partials.Channel],
});
const claimBackend = createBackendClient({
	surfaceKind: "discord",
	serviceTokenEnv: "DISCORD_SERVICE_TOKEN",
	authHeaderName: "x-discord-service-token",
	routePrefix: "/agent",
});
const claims = createEventClaims({
	backend: claimBackend,
	surfaceKind: "discord",
});
const resolveTurnTarget = createTurnTargetResolver({
	backend: claimBackend,
	hasPerUserAuth: () => Boolean(convexServiceToken()),
	legacyProjectId: () => process.env.MCPJAM_PROJECT_ID,
});
const api = createApiClient({
	routePrefix: "/agent",
	conversationField: "conversationId",
	baseUrl: process.env.MCPJAM_BASE_URL,
	getConfig,
});

client.once(Events.ClientReady, async (ready) => {
	for (const guild of ready.guilds.cache.values())
		await recordPresence({ tenantId: guild.id, status: "installed" });
});
client.on(Events.GuildCreate, (guild) =>
	recordPresence({ tenantId: guild.id, status: "installed" }),
);
client.on(Events.GuildDelete, (guild) =>
	recordPresence({ tenantId: guild.id, status: "removed" }),
);

client.on(Events.InteractionCreate, async (interaction) => {
	if (!interaction.isChatInputCommand() || interaction.commandName !== "mcpjam")
		return;
	if (!interaction.guildId) {
		await interaction.reply({
			content: "MCPJam connect is available in a server, not in DMs.",
			ephemeral: true,
			allowedMentions: { parse: [] },
		});
		return;
	}
	await interaction.reply({
		content: "Connect your MCPJam account to continue.",
		ephemeral: true,
		allowedMentions: { parse: [] },
	});
	try {
		const url = await mintConnectUrl({
			surfaceKind: "discord",
			tenantId: interaction.guildId,
			actorId: interaction.user.id,
			token: requireApiServiceToken(),
			baseUrl: baseUrl(),
			origins: connectLinkOrigins(),
		});
		await interaction.editReply({
			content: `Connect MCPJam: ${url}`,
			allowedMentions: { parse: [] },
		});
	} catch (error) {
		await interaction.editReply({
			content: `Unable to create a connect link: ${error.message}`,
			allowedMentions: { parse: [] },
		});
	}
});

client.on(Events.MessageCreate, async (message) => {
	if (
		!botEnabled ||
		message.author.bot ||
		!message.guildId ||
		!message.mentions.has(client.user)
	)
		return;
	const dedupeKey = `${message.guildId}:${message.id}`;
	if (claims.hasClaimBackend()) {
		const claim = await claims.claimEvent(dedupeKey);
		if (claim.outcome !== "claimed") return;
	}
	const identity = deriveConversationIdentity(message);
	// No `projectId` before the target resolves. Seeding it from the environment
	// makes every unresolved path act in whatever project the operator happened
	// to set, which is a cross-project write dressed up as a default.
	const ref = {
		surfaceKind: "discord",
		tenantId: message.guildId,
		actorId: message.author.id,
		conversationId: identity.conversationId,
		threadId: identity.threadId,
	};
	const delivery = createDiscordDelivery(message.channel);
	try {
		const target = await resolveTurnTarget(ref, {
			conversationId: identity.conversationId,
			threadId: identity.threadId,
		});
		if (target.mode === "unlinked") {
			const url = await mintConnectUrl({
				surfaceKind: "discord",
				tenantId: message.guildId,
				actorId: message.author.id,
				token: requireApiServiceToken(),
				baseUrl: baseUrl(),
				origins: connectLinkOrigins(),
			});
			const content = {
				severity: "info",
				parts: [
					"Connect MCPJam before asking me to act: ",
					{ link: { url, label: "open the connect link" } },
				],
			};
			await delivery.deliver(ref, content);
			if (claims.hasClaimBackend())
				await claims.completeEvent(dedupeKey, content);
			return;
		}
		if (target.mode === "needs_project") {
			const content = textContent(
				"Your account is connected, but no default MCPJam project is configured for this organization. Set one in MCPJam settings and mention me again.",
				"warning",
			);
			await delivery.deliver(ref, content);
			if (claims.hasClaimBackend())
				await claims.completeEvent(dedupeKey, content);
			return;
		}
		ref.projectId = target.projectId;
		const bound = await ensureThreadBinding({
			backend: claimBackend,
			ctx: ref,
			conversationId: identity.conversationId,
			threadId: identity.threadId,
			target,
		});
		if (!bound.ok) {
			// FAIL the turn rather than running unbound. An unbound thread
			// re-resolves on every reply, so the next person to speak would get
			// THEIR default project and create resources somewhere the initiator
			// never chose — a silent cross-project write, which is worse than a
			// visible "try again".
			//
			// Released, not completed: the bind failure is transient, so a
			// redelivery of this same message should be allowed to run. Two things
			// protect that, and BOTH are needed. `channel.send` can reject on a rate
			// limit, a missing permission or a deleted channel, and this handler's
			// outer catch ends in `completeEvent` — so a propagating send failure
			// would mark the turn permanently done. Hence: release first, and
			// contain the send's throw rather than letting it reach that catch.
			if (claims.hasClaimBackend())
				await claims.releaseEvent(dedupeKey).catch((error) => {
					// Swallowing this hides the one failure that strands the message.
					console.error(`Could not release claim ${dedupeKey}: ${error}`);
				});
			await delivery
				.deliver(
					ref,
					textContent(
						"I could not pin this thread to a project. Try again in a moment.",
						"warning",
					),
				)
				.catch((error) => {
					// Nothing more can be said to the user: the only channel we have is
					// the one that just refused a message. Carry the ids so the dropped
					// turn is at least traceable from the logs.
					console.error(
						`Could not report the bind failure for ${dedupeKey} in ${identity.conversationId}: ${error}`,
					);
				});
			return;
		}
		if (bound.projectId) ref.projectId = bound.projectId;
		const result = await runTurn({
			ref,
			fetchHistory: (args) =>
				fetchHistory({
					...args,
					channel: message.channel,
					// The core derives no trigger id from `ref`, so pass the snowflake
					// explicitly: it is what gives the newer-than-trigger cutoff
					// sub-millisecond resolution.
					triggerMessageId: message.id,
					botUserId: client.user.id,
				}),
			deliver: (target, content) => delivery.deliver(target, content),
			turn: (history) =>
				api
					.runAgentTurn(history, ref, {
						conversationId: message.channelId,
						idempotencyKey: dedupeKey,
					})
					.then((result) => ({
						...textContent(result.reply || "", "info"),
						proposedActions: result.proposedActions || [],
					})),
			triggerTimestampMs: Number(message.createdTimestamp),
		});
		if (claims.hasClaimBackend())
			await claims.completeEvent(dedupeKey, result.envelope);
	} catch (error) {
		await delivery.deliver(
			ref,
			error?.structuredContent ||
				textContent(
					error?.friendlyMessage ||
						error?.message ||
						"The agent could not complete this turn.",
				),
		);
		if (claims.hasClaimBackend())
			await claims.completeEvent(dedupeKey, { error: error.message });
	}
});

client.on(Events.InteractionCreate, async (interaction) => {
	if (!interaction.isButton() || !interaction.guildId) return;
	// Button interactions, unlike Gateway messages, have the three-second ack
	// deadline. Defer immediately, then execute from the opaque server id.
	try {
		await interaction.deferUpdate();
	} catch {
		return;
	}
	const ref = {
		surfaceKind: "discord",
		tenantId: interaction.guildId,
		actorId: interaction.user.id,
		projectId: process.env.MCPJAM_PROJECT_ID,
		conversationId: interaction.channelId,
	};
	try {
		const result = await api.executeProposedAction(interaction.customId, ref);
		if (result.runId && interaction.channel?.isTextBased?.()) {
			const surfaceDelivery = createDiscordDelivery(interaction.channel);
			const status = await surfaceDelivery.deliver(
				ref,
				textContent(
					`Run started${result.runUrl ? ` — ${result.runUrl}` : ""}.`,
					"info",
				),
			);
			const statusHandle = status.handles.at(-1);
			if (statusHandle) {
				void watchDiscordRun({
					apiClient: api,
					ctx: ref,
					runId: result.runId,
					handle: statusHandle,
					surfaceDelivery,
					url: result.runUrl || "",
					actorId: interaction.user.id,
				});
			}
		}
		await interaction.followUp({
			content: `Approved: ${result.operation || "action complete"}`,
			ephemeral: true,
			allowedMentions: { parse: [] },
		});
	} catch (error) {
		await interaction.followUp({
			content: `Unable to approve this action: ${error?.friendlyMessage || error?.message || "try again later"}`,
			ephemeral: true,
			allowedMentions: { parse: [] },
		});
	}
});

if (process.env.DISCORD_APPLICATION_ID && process.env.DISCORD_GUILD_ID) {
	const rest = new REST({ version: "10" }).setToken(token);
	await rest.put(
		Routes.applicationGuildCommands(
			process.env.DISCORD_APPLICATION_ID,
			process.env.DISCORD_GUILD_ID,
		),
		{
			body: [
				new SlashCommandBuilder()
					.setName("mcpjam")
					.setDescription("MCPJam commands")
					.addSubcommand((subcommand) =>
						subcommand.setName("connect").setDescription("Connect MCPJam"),
					),
			],
		},
	);
}
await client.login(token);
