// @ts-nocheck
import {
	createApiClient,
	createBackendClient,
	createChannelBindingCache,
	createEventClaims,
	createTurnTargetResolver,
	EventDedupe,
	mintConnectUrl,
	runTurnForEvent,
	textContent,
} from "@mcpjam/surface-core";
import { Client, Events, GatewayIntentBits, Partials, REST } from "discord.js";
import { MCPJAM_COMMANDS, resolveCommandRegistration } from "./commands.js";
import { config, describeConfigGaps } from "./config.js";
import { buildInteractionRef, buildMessageRef } from "./context.js";
import { createDiscordDelivery } from "./delivery.js";
import { fetchHistory } from "./history.js";
import { recordPresence } from "./presence.js";
import { toDeliverableResult, toReplayContent } from "./turn-result.js";
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
	// The SNAPSHOT, not `serviceTokenEnv`. Reading the variable itself would
	// put this client on a second source of truth: `config.convexServiceToken`
	// trims, so a token set to whitespace is `undefined` there and truthy here.
	// The config would then report Convex auth off while this client kept
	// sending a blank credential, turning documented no-ops into 401s.
	serviceToken: config.convexServiceToken,
	authHeaderName: "x-discord-service-token",
	routePrefix: "/agent",
});
const claims = createEventClaims({
	backend: claimBackend,
	surfaceKind: "discord",
});
// The "connect your account" / "pick a project" prompts happen BEFORE
// runTurnForEvent's own durable claim (they return before a target is ever
// resolved into a turn), so a Gateway redelivery of the same mention while
// the user is still unlinked would otherwise re-post the prompt. In-memory
// only, and deliberately NOT the durable claim backend: taking that here
// too would collide with runTurnForEvent's own claim on the same
// `guildId:messageId` key once the user IS linked, silently dropping the
// turn (the inner claim would see "inflight" against a claim this code
// already opened and never completed). A prompt is cheap to resend and
// short-TTL in-memory suppression is all the redelivery case needs.
const promptDedupe = new EventDedupe();
// Every mention asks whether its channel is bound, which put a Convex round
// trip on the hot path of every single message with no caching at all.
// Channel bindings are written by an admin through a separate settings flow,
// not by the turn reading one, so caching (including a "no binding" answer —
// the common case) is safe. See channel-binding-cache.js for why this does
// not also cover thread bindings.
const channelBindingCache = createChannelBindingCache();
const resolveTurnTarget = createTurnTargetResolver({
	backend: claimBackend,
	hasPerUserAuth: () => Boolean(config.convexServiceToken),
	legacyProjectId: () => config.legacyProjectId,
	channelBindingCache,
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
client.on(Events.GuildDelete, (guild) => {
	// A removed-then-reinstalled guild may come back under a DIFFERENT org.
	// Without this, the first minute of turns after reinstall could still be
	// routed by channel bindings written for the org that just left.
	channelBindingCache.clearTenant(`discord:${guild.id}:`);
	detach(
		recordPresence({ tenantId: guild.id, status: "removed" }),
		`presence removed (${guild.id})`,
	);
});

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

		if (target.mode === "unlinked" || target.mode === "needs_project") {
			// One message may redeliver on a Gateway resume; without this a
			// redelivery while still unlinked/unconfigured re-posts the same
			// prompt. See promptDedupe's own comment for why this is NOT the
			// durable claim.
			if (!promptDedupe.claim(message.id)) return;
			if (target.mode === "unlinked") {
				const url = await connectUrlFor({
					tenantId: message.guildId,
					actorId: message.author.id,
				});
				await delivery.deliver(ref, {
					severity: "info",
					parts: [
						"Connect MCPJam before asking me to act: ",
						{ link: { url, label: "open the connect link" } },
					],
				});
			} else {
				await delivery.deliver(
					ref,
					textContent(
						"Your account is connected, but no default MCPJam project is configured for this organization. Set one in MCPJam settings and mention me again.",
						"warning",
					),
				);
			}
			return;
		}

		ref.projectId = target.projectId;

		// Claim, dedupe, per-conversation serialization and redelivery-replay
		// now live in the core's runTurnForEvent — the same durable-claim state
		// machine slack-app runs on. `eventId: message.id` keeps the claim key
		// close to what this file computed by hand before (Discord message ids
		// are globally unique, so no extra components are needed).
		await runTurnForEvent({
			ctx: ref,
			conversationId: context.conversationId,
			threadId: context.threadId,
			eventId: message.id,
			triggerMessageId: message.id,
			// The core derives no trigger id from `ctx`, so pass the snowflake's
			// millisecond timestamp explicitly — it is what gives the
			// newer-than-trigger cutoff its resolution.
			triggerTimestampMs: Number(message.createdTimestamp),
			botUserId: client.user.id,
			fallbackText: message.content || "",
			eventClaims: claims,
			// RAW rows — the core owns normalization now, exactly once. Fetching
			// from `message.channel` (the THREAD, when in one) is what keeps
			// history non-empty now that `conversationId` is the parent.
			fetchHistory: (args) =>
				fetchHistory({
					...args,
					channel: message.channel,
					triggerMessageId: message.id,
					botUserId: client.user.id,
				}),
			apiClient: {
				runAgentTurn: (history, _coreCtx, opts) =>
					api
						.runAgentTurn(history, ref, {
							// The DERIVED conversation, not `message.channelId` —
							// otherwise a thread turn is recorded against the thread
							// while its binding lives on the parent.
							conversationId: context.conversationId,
							idempotencyKey: opts.idempotencyKey,
						})
						.then(toDeliverableResult),
			},
			onResult: async (result) => {
				await delivery.deliver(ref, result);

				// BIND THE THREAD once the turn has actually succeeded in it.
				// Binding earlier would persist a mapping for a conversation that
				// never worked; binding on a channel-mode target would claim a
				// thread the resolver did not decide, so this is limited to a
				// user-mode target in a thread that is not already bound.
				//
				// Runs INSIDE onResult — the core completes the durable claim
				// right after onResult returns, storing the TURN's own result
				// either way, so the bind attempt (best-effort, its own failure
				// only produces a warning) cannot rewrite what gets replayed on a
				// redelivery. Slack refuses the turn outright when it cannot bind;
				// Discord binds AFTER the turn has already run and replied, so
				// refusing is not available — the honest equivalent is to say the
				// thread is not pinned, which also tells the user that mentioning
				// again will re-bind.
				//
				// `organizationId` is required by the backend, which checks it
				// against the initiator's account link and rejects a mismatch. A
				// user-mode target always carries one; the guard says so rather
				// than sending undefined and taking a 400.
				if (
					!(
						context.isThread &&
						target.mode === "user" &&
						!target.boundThread &&
						target.organizationId &&
						target.projectId &&
						claims.hasClaimBackend()
					)
				)
					return;
				const bound = await claimBackend
					.createThreadBinding(ref, context.conversationId, context.threadId, {
						projectId: target.projectId,
						organizationId: target.organizationId,
					})
					.catch((error) => {
						console.error(
							`[discord] could not bind thread ${context.threadId}: ${
								error?.message ?? error
							}`,
						);
						return null;
					});
				if (bound) return;
				await delivery
					.deliver(
						ref,
						textContent(
							"I answered, but I could not pin this thread to a project — later replies here will use whichever project the person speaking has selected. Mention me again to retry.",
							"warning",
						),
					)
					.catch((error) => {
						console.warn(
							`[discord] could not post the unpinned-thread warning for ${message.id} in ${context.conversationId}: ${
								error?.message ?? error
							}`,
						);
					});
			},
			// A redelivery of an event already answered: re-post the stored
			// reply rather than re-running the turn. See turn-result.js for why
			// this needs its own rebuild rather than delivering the envelope raw.
			onReplay: async (envelope) => {
				await delivery.deliver(ref, toReplayContent(envelope));
			},
		});
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

// Guild-scoped when DISCORD_DEV_GUILD_ID is set (the development override:
// instant propagation in one server), GLOBAL otherwise so every server the
// bot is added to gets `/mcpjam`. See commands.js for the full reasoning,
// including why this reads a NEW variable rather than the old
// DISCORD_GUILD_ID.
const registration = resolveCommandRegistration({
	applicationId: config.applicationId,
	devGuildId: config.devGuildId,
});
if (registration.scope === "skipped") {
	console.warn(
		"[discord] DISCORD_APPLICATION_ID is not set — slash commands are not registered. Mentioning the bot still works.",
	);
} else {
	const rest = new REST({ version: "10" }).setToken(config.botToken);
	// Best-effort: a failed registration must not stop the bot from
	// connecting. The @-mention path offers the same connect link, so a bot
	// that is up without its slash command is degraded, not broken — and
	// crashing here would take down every guild over one bad API call.
	try {
		await rest.put(registration.route, { body: MCPJAM_COMMANDS });
		console.log(
			registration.scope === "guild"
				? `[discord] registered slash commands to guild ${config.devGuildId} (DISCORD_DEV_GUILD_ID development override)`
				: "[discord] registered slash commands globally; Discord may take up to an hour to propagate them",
		);
	} catch (error) {
		console.error(
			`[discord] could not register slash commands (${registration.scope}): ${
				error?.message ?? error
			}`,
		);
	}
}

await client.login(config.botToken);
