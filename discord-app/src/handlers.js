// @ts-nocheck
import {
	createTurnTargetResolver,
	McpjamApiError,
	runTurnForEvent,
	textContent,
} from "@mcpjam/surface-core";
import { apiClient, backend, eventClaims, mintConnectUrl } from "./backend.js";
import {
	contextFromMessage,
	isBotMention,
	promptFromMessage,
} from "./context.js";
import { statusContent, turnContent } from "./copy.js";
import { DiscordDeliverySurface } from "./delivery.js";
import { discordEnabled } from "./flag.js";
import { fetchHistory } from "./history.js";

const delivery = new DiscordDeliverySurface();

/** @param {any} client @param {{enabled?:unknown,logger?:any}} [options] */
export function createDiscordHandlers(client, options = {}) {
	const enabled = () =>
		discordEnabled(
			options.enabled === undefined
				? process.env.MCPJAM_DISCORD_ENABLED === "true"
				: options.enabled,
		);
	const resolveTurnTarget =
		options.resolveTurnTarget ||
		createTurnTargetResolver({ backend, surfaceKind: "discord" });
	/** @param {any} guild @param {'installed'|'removed'} status */
	async function handleGuildLifecycle(guild, status) {
		if (!enabled()) return;
		await backend
			.post("/agent/install-presence", {
				surfaceKind: "discord",
				surfaceTenantId: guild.id,
				status,
				occurredAt: Date.now(),
			})
			.catch((error) =>
				options.logger?.warn?.(
					`Could not record Discord guild presence: ${error}`,
				),
			);
	}

	/** @param {any} message */
	async function handleMessage(message) {
		if (!enabled() || message.author?.bot || !isBotMention(message, client))
			return false;
		const ctx = contextFromMessage(message, client);
		if (!ctx) return false;
		let statusHandle = null;
		const ref = { message, channel: message.channel };
		try {
			const target = await resolveTurnTarget(ctx, {
				conversationId: ctx.conversationId,
				threadId: ctx.threadId,
			});
			if (target.mode === "unlinked") {
				await delivery.deliver(ref, {
					severity: "error",
					parts: ["Connect your MCPJam account first with `/mcpjam connect`."],
				});
				return false;
			}
			if (target.mode === "needs_project") {
				await delivery.deliver(ref, {
					severity: "error",
					parts: ["Choose a default MCPJam project before starting a turn."],
				});
				return false;
			}
			const targetCtx = { ...ctx, projectId: target.projectId };
			return await runTurnForEvent({
				ctx: targetCtx,
				conversationId: ctx.conversationId,
				threadId: ctx.threadId,
				triggerMessageId: message.id,
				triggerTimestampMs: message.createdTimestamp,
				eventId: message.id,
				fallbackText: promptFromMessage(message, client),
				fetchHistory: (args) => fetchHistory(message.channel, args),
				delivery,
				apiClient,
				eventClaims,
				onStart: async () => {
					statusHandle =
						(await delivery.deliver(ref, statusContent("Working on it…")))
							.handles[0] || null;
				},
				onResult: async (result) => {
					await delivery.deliver(
						ref,
						turnContent(result.reply, result.proposedActions),
					);
				},
				onReplay: async (result) => {
					await delivery.deliver(
						ref,
						turnContent(result.reply, result.proposedActions),
					);
				},
			});
		} catch (error) {
			const content =
				error instanceof McpjamApiError
					? error.structuredContent
					: textContent(
							"Something went wrong running that turn. Ask again to retry.",
							"error",
						);
			if (statusHandle)
				await delivery.edit(statusHandle, content).catch(() => {});
			else await delivery.deliver(ref, content).catch(() => {});
			return false;
		}
	}

	/** @param {any} interaction */
	async function handleInteraction(interaction) {
		if (!enabled()) return false;
		if (
			interaction.isChatInputCommand?.() &&
			interaction.commandName === "mcpjam" &&
			interaction.options?.getSubcommand?.() === "connect"
		) {
			await interaction.deferReply({ ephemeral: true });
			const ctx = {
				surfaceKind: "discord",
				tenantId: interaction.guildId,
				actorId: interaction.user.id,
			};
			if (!ctx.tenantId)
				return interaction.editReply(
					"Connect is available in a guild, not in a DM.",
				);
			try {
				const url = await mintConnectUrl(ctx);
				return interaction.editReply(`Connect your MCPJam account: ${url}`);
			} catch (error) {
				options.logger?.warn?.(`Could not mint Discord connect URL: ${error}`);
				return interaction.editReply(
					"I could not prepare a connect link right now. Try again in a moment.",
				);
			}
		}
		if (interaction.isButton?.()) {
			await interaction.deferUpdate();
			const actionId = String(interaction.customId || "");
			if (!actionId || actionId.length > 100) return false;
			const record = await backend
				.fetchProposedAction(actionId)
				.catch(() => null);
			const ctx = {
				surfaceKind: "discord",
				tenantId: interaction.guildId,
				actorId: interaction.user.id,
				projectId: record?.projectId,
			};
			if (!ctx.tenantId) return false;
			try {
				const outcome = await apiClient.executeProposedAction(actionId, ctx);
				await interaction.followUp({
					content: outcome.runUrl
						? `Approved — ${outcome.runUrl}`
						: "Approved — the action is complete.",
					ephemeral: true,
					allowedMentions: { parse: [], users: [], roles: [] },
				});
			} catch (error) {
				const message =
					error instanceof McpjamApiError
						? error.friendlyMessage
						: "I could not complete that approval. Try again in a moment.";
				await interaction
					.followUp({
						content: message,
						ephemeral: true,
						allowedMentions: { parse: [], users: [], roles: [] },
					})
					.catch(() => {});
			}
			return true;
		}
		return false;
	}
	return {
		handleMessage,
		handleInteraction,
		handleGuildCreate: (/** @type {any} */ guild) =>
			handleGuildLifecycle(guild, "installed"),
		handleGuildDelete: (/** @type {any} */ guild) =>
			handleGuildLifecycle(guild, "removed"),
	};
}
