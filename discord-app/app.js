// @ts-nocheck
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
import { config, describeConfigGaps } from "./config.js";
import { buildInteractionRef, buildMessageRef } from "./context.js";
import { createDiscordDelivery } from "./delivery.js";
import { fetchHistory } from "./history.js";
import { recordPresence } from "./presence.js";
import { watchDiscordRun } from "./watcher.js";

if (!config.botToken) throw new Error("DISCORD_BOT_TOKEN is required");
for (const warning of describeConfigGaps(config)) {
	console.warn(`[discord] ${warning}`);
}

/**
 * PROCESS-LEVEL SAFETY NET.
 *
 * This app is a long-lived Gateway client whose handlers are all
 * fire-and-forget: discord.js does not await them and has nowhere to report a
 * rejection. Node's default for an unhandled rejection is to KILL THE PROCESS,
 * so a single transient failure inside any handler would disconnect the bot
 * from every guild it serves. These handlers turn that into a log line.
 *
 * Deliberately log-and-continue rather than log-and-exit: the failure modes
 * this actually catches are network blips in best-effort writes, and dropping
 * the Gateway connection is a much larger outage than the thing that failed.
 */
process.on("unhandledRejection", (reason) => {
	console.error("[discord] unhandled rejection:", reason);
});
process.on("uncaughtException", (error) => {
	console.error("[discord] uncaught exception:", error);
});

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
	hasPerUserAuth: () => Boolean(config.convexServiceToken),
	legacyProjectId: () => config.legacyProjectId,
});

const api = createApiClient({
	routePrefix: "/agent",
	conversationField: "conversationId",
	baseUrl: config.baseUrl,
	getConfig: (ctx, overrides = {}) => ({
		// The INSPECTOR credential. Not `convexServiceToken` — different service,
		// different trust boundary. There used to be three different fallback
		// chains across this file that disagreed about which one to reach for;
		// see config.js.
		apiKey: overrides.apiKey || config.inspectorApiToken,
		projectId: overrides.projectId || ctx.projectId,
		baseUrl: overrides.baseUrl || config.baseUrl,
		appUrl: config.appUrl,
		headers: {
			"x-mcpjam-surface-tenant-id": ctx.tenantId,
			"x-mcpjam-surface-actor-id": ctx.actorId,
		},
		routePrefix: "/agent",
	}),
});

/** Mint a connect link for one person in one guild. */
function connectUrlFor({ tenantId, actorId }) {
	return mintConnectUrl({
		surfaceKind: "discord",
		tenantId,
		actorId,
		// Surface-link lives on the Inspector, so this is the Inspector token.
		token: config.inspectorApiToken,
		baseUrl: config.baseUrl,
		origins: config.linkOrigins,
	});
}

/** Fire-and-forget, but never process-fatal. See the handlers above. */
function detach(promise, label) {
	Promise.resolve(promise).catch((error) => {
		console.warn(`[discord] ${label} failed: ${error?.message ?? error}`);
	});
}

client.once(Events.ClientReady, (ready) => {
	for (const guild of ready.guilds.cache.values()) {
		detach(
			recordPresence({ tenantId: guild.id, status: "installed" }),
			`presence installed (${guild.id})`,
		);
	}
});
client.on(Events.GuildCreate, (guild) =>
	detach(
		recordPresence({ tenantId: guild.id, status: "installed" }),
		`presence installed (${guild.id})`,
	),
);
client.on(Events.GuildDelete, (guild) =>
	detach(
		recordPresence({ tenantId: guild.id, status: "removed" }),
		`presence removed (${guild.id})`,
	),
);

// ── /mcpjam connect ─────────────────────────────────────────────────────────

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
		const url = await connectUrlFor({
			tenantId: interaction.guildId,
			actorId: interaction.user.id,
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

// ── The agent turn ──────────────────────────────────────────────────────────

client.on(Events.MessageCreate, async (message) => {
	if (
		!config.botEnabled ||
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

	// THREAD IDENTITY. In a thread the conversation is the PARENT channel and
	// the thread is the thread — not `threadId: message.id`, which gave every
	// message its own thread id so no binding ever matched. See context.js.
	const { ref, context } = buildMessageRef(message, {
		legacyProjectId: config.legacyProjectId,
	});
	const delivery = createDiscordDelivery(message.channel);

	try {
		const target = await resolveTurnTarget(ref, {
			conversationId: context.conversationId,
			threadId: context.threadId,
		});

		if (target.mode === "unlinked") {
			const url = await connectUrlFor({
				tenantId: message.guildId,
				actorId: message.author.id,
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
		const result = await runTurn({
			ref,
			// RAW rows. `runTurn` normalizes; `fetchHistory` used to normalize too,
			// and the second pass erased the assistant's turns. Fetching from
			// `message.channel` (the thread, when in one) is also what keeps the
			// history non-empty now that `conversationId` is the parent.
			fetchHistory: () => fetchHistory({ channel: message.channel, limit: 50 }),
			deliver: (deliverTarget, content) =>
				delivery.deliver(deliverTarget, content),
			turn: (history) =>
				api
					.runAgentTurn(history, ref, {
						// The DERIVED conversation, not `message.channelId` — otherwise a
						// thread turn is recorded against the thread while its binding
						// lives on the parent.
						conversationId: context.conversationId,
						idempotencyKey: dedupeKey,
					})
					.then((turnResult) => ({
						...textContent(turnResult.reply || "", "info"),
						proposedActions: turnResult.proposedActions || [],
					})),
			triggerTimestampMs: Number(message.createdTimestamp),
		});

		// BIND THE THREAD once a turn has actually succeeded in it. Binding
		// earlier would persist a mapping for a conversation that never worked;
		// binding on a channel-mode target would claim a thread the resolver did
		// not decide, so this is limited to a user-mode target in a thread that
		// is not already bound.
		if (
			context.isThread &&
			target.mode === "user" &&
			!target.boundThread &&
			claims.hasClaimBackend()
		) {
			detach(
				claimBackend.createThreadBinding({
					...ref,
					channelId: context.conversationId,
					threadId: context.threadId,
					projectId: target.projectId,
				}),
				`thread binding (${context.threadId})`,
			);
		}

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

// ── Approval buttons ────────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
	if (!interaction.isButton() || !interaction.guildId) return;
	// Button interactions, unlike Gateway messages, have the three-second ack
	// deadline. Defer immediately, then execute from the opaque server id.
	try {
		await interaction.deferUpdate();
	} catch {
		return;
	}

	/** Ephemeral, so a refusal is seen by the clicker and nobody else. */
	const tellClicker = async (content) => {
		try {
			await interaction.followUp({
				content,
				ephemeral: true,
				allowedMentions: { parse: [] },
			});
		} catch (error) {
			console.warn(
				`[discord] could not reply to the clicker: ${error?.message ?? error}`,
			);
		}
	};

	// Same thread derivation as the turn path: a button clicked INSIDE a thread
	// must resolve against the parent conversation, or the binding lookup misses
	// and an approval that should work reports "not linked".
	const { ref, context } = buildInteractionRef(interaction, {
		legacyProjectId: config.legacyProjectId,
	});

	// THE CLICKER IS THE AUTHORIZER. Re-resolve for whoever clicked — not for
	// whoever's message produced the proposal — so the server acts as THEM and
	// re-checks their membership. Without this the handler ran with
	// `MCPJAM_PROJECT_ID` from the environment, meaning a button left in a
	// channel could be pressed by someone who was never linked, or who has since
	// been removed from the org, and spend against a project chosen by an env
	// var rather than by their access.
	let target;
	try {
		target = await resolveTurnTarget(ref, {
			conversationId: context.conversationId,
			threadId: context.threadId,
		});
	} catch (error) {
		console.error(
			`[discord] could not resolve the approval target: ${error?.message ?? error}`,
		);
		await tellClicker(
			"I could not check your MCPJam access just now. Try again in a moment.",
		);
		return;
	}
	if (target.mode === "unlinked") {
		let hint = "Connect your MCPJam account before approving this.";
		try {
			const url = await connectUrlFor({
				tenantId: interaction.guildId,
				actorId: interaction.user.id,
			});
			hint = `Connect your MCPJam account before approving this: ${url}`;
		} catch {
			// Fall back to the bare instruction — a missing link is not a reason
			// to leave the click unanswered.
		}
		await tellClicker(hint);
		return;
	}
	if (target.mode === "needs_project") {
		await tellClicker(
			"Your account is connected, but no default MCPJam project is configured for this organization. Set one in MCPJam settings, then approve again.",
		);
		return;
	}

	// The RESOLVED project and org, not the env var.
	const runCtx = { ...ref, mode: target.mode, projectId: target.projectId };

	try {
		const result = await api.executeProposedAction(
			interaction.customId,
			runCtx,
		);
		if (result.runId && interaction.channel?.isTextBased?.()) {
			const surfaceDelivery = createDiscordDelivery(interaction.channel);
			const status = await surfaceDelivery.deliver(
				runCtx,
				textContent(
					`Run started${result.runUrl ? ` — ${result.runUrl}` : ""}.`,
					"info",
				),
			);
			const statusHandle = status.handles.at(-1);
			if (statusHandle) {
				detach(
					watchDiscordRun({
						apiClient: api,
						ctx: runCtx,
						runId: result.runId,
						handle: statusHandle,
						surfaceDelivery,
						url: result.runUrl || "",
						actorId: interaction.user.id,
					}),
					`run watcher (${result.runId})`,
				);
			}
		}
		await tellClicker(`Approved: ${result.operation || "action complete"}`);
	} catch (error) {
		await tellClicker(
			`Unable to approve this action: ${
				error?.friendlyMessage || error?.message || "try again later"
			}`,
		);
	}
});

// ── Slash-command registration ──────────────────────────────────────────────

if (config.applicationId && config.guildId) {
	const rest = new REST({ version: "10" }).setToken(config.botToken);
	await rest.put(
		Routes.applicationGuildCommands(config.applicationId, config.guildId),
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

await client.login(config.botToken);
