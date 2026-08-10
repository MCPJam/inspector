import { McpjamApiError } from "./api-client.js";

const MAX_MESSAGES = 50;
const MAX_MESSAGE_CHARS = 8_000;
const MAX_MESSAGE_BYTES = 8_192;
const MAX_TOTAL_MESSAGE_BYTES = 98_304;

/** @param {string} text */
const utf8Length = (text) => Buffer.byteLength(text, "utf8");

/** @param {string} text */
export function capMessageContent(text) {
	if (text.length <= MAX_MESSAGE_CHARS && utf8Length(text) <= MAX_MESSAGE_BYTES)
		return text;
	const suffix = "…";
	let units = 0;
	let bytes = 0;
	let out = "";
	for (const char of text) {
		if (
			units + char.length > MAX_MESSAGE_CHARS - 1 ||
			bytes + utf8Length(char) > MAX_MESSAGE_BYTES - utf8Length(suffix)
		)
			break;
		units += char.length;
		bytes += utf8Length(char);
		out += char;
	}
	return out + suffix;
}

export class EventDedupe {
	/** @param {{ttlMs?: number, now?: () => number}} [options] */
	constructor(options = {}) {
		this.ttlMs = options.ttlMs ?? 30 * 60_000;
		this.now = options.now ?? Date.now;
		/** @type {Map<string, number>} */
		this.seen = new Map();
	}
	/** @param {string} key */
	claim(key) {
		this.sweep();
		if (this.seen.has(key)) return false;
		this.seen.set(key, Infinity);
		return true;
	}
	/** @param {string} key */
	complete(key) {
		if (this.seen.has(key)) this.seen.set(key, this.now());
	}
	/** @param {string} key */
	release(key) {
		this.seen.delete(key);
	}
	clear() {
		this.seen.clear();
	}
	sweep() {
		const cutoff = this.now() - this.ttlMs;
		for (const [key, time] of this.seen)
			if (time !== Infinity && time < cutoff) this.seen.delete(key);
	}
}

export class KeyedQueue {
	constructor() {
		/** @type {Map<string, Promise<any>>} */
		this.chains = new Map();
	}
	/** @param {string} key @param {() => Promise<any>} job */
	enqueue(key, job) {
		const previous = this.chains.get(key) || Promise.resolve();
		const next = previous.then(job, job);
		const settled = next.then(
			() => undefined,
			() => undefined,
		);
		this.chains.set(key, settled);
		settled.then(() => {
			if (this.chains.get(key) === settled) this.chains.delete(key);
		});
		return next;
	}
}

/**
 * Module-level shared instances, mirroring the Slack fork this module is
 * meant to replace.
 *
 * `runTurnForEvent`'s `dedupe`/`queue` params default to a FRESH instance per
 * call unless a caller injects one — which means dedupe and per-conversation
 * serialization silently do nothing for any caller that does not know to
 * share an instance across its own calls. That is not a safe default for a
 * module whose whole job is dedupe and serialization. Exporting one shared
 * pair and defaulting to THEM restores "just works" for a single-process
 * surface, while a caller that genuinely wants isolation (tests, multiple
 * independent bots in one process) can still pass its own.
 */
export const dedupe = new EventDedupe();
export const queue = new KeyedQueue();

/** @param {Array<Record<string,any>>} raw @param {{triggerMessageId?:string,triggerTimestampMs?:number,botUserId?:string}} opts */
export function normalizeEnvelope(raw, opts) {
	const triggerMs = opts.triggerTimestampMs;
	const messages = [];
	for (const message of raw) {
		const content = String(message.content ?? message.text ?? "").trim();
		if (!content) continue;
		const timestampMs = Number(message.timestampMs);
		if (
			typeof triggerMs === "number" &&
			Number.isFinite(triggerMs) &&
			Number.isFinite(timestampMs) &&
			timestampMs > triggerMs
		)
			continue;
		// IDEMPOTENT. A row that already carries a `role` and none of the raw
		// authorship fields has been through here (or through a surface adapter
		// that normalizes first) — trust it. Re-deriving from `isBot`/`authorId`
		// on such a row would find neither and label EVERY message "user",
		// silently erasing the assistant's turns from its own history and making
		// a multi-turn thread read as a wall of user messages. Both entry points
		// (`runTurnForEvent` and `runTurn`) share this function, so both get it.
		const preNormalized =
			typeof message.role === "string" &&
			message.isBot === undefined &&
			message.authorId === undefined;
		messages.push({
			role: preNormalized
				? message.role
				: message.isBot ||
						(opts.botUserId && message.authorId === opts.botUserId)
					? "assistant"
					: "user",
			content: capMessageContent(content),
		});
	}
	const recent = messages.slice(-MAX_MESSAGES);
	let total = recent.reduce((sum, item) => sum + utf8Length(item.content), 0);
	while (recent.length > 1 && total > MAX_TOTAL_MESSAGE_BYTES) {
		total -= utf8Length(recent[0].content);
		recent.shift();
	}
	return recent;
}

/**
 * Compatibility name — the Slack adapter's entry point once it migrates onto
 * this core (see slack-app/agent/turn-runner.js, which currently has its own
 * copy). Slack's ts values are its own unit: a decimal-seconds string, not
 * milliseconds. `opts.triggerTs` is translated here for the same reason each
 * row's own `ts` is translated below — a caller that passes `triggerTs`
 * without this translation would have the newer-than-trigger cutoff in
 * `normalizeEnvelope` silently never fire, because `triggerTimestampMs` would
 * stay undefined.
 * @param {Array<Record<string,any>>} raw
 * @param {{triggerMessageId?:string,triggerTimestampMs?:number,triggerTs?:string,botUserId?:string}} [opts]
 */
export function normalizeThreadMessages(raw, opts = {}) {
	return normalizeEnvelope(
		raw.map((message) => ({
			...message,
			timestampMs:
				message.timestampMs ??
				(message.ts ? Number.parseFloat(message.ts) * 1000 : undefined),
			authorId: message.authorId ?? message.user,
			// ABSENT STAYS ABSENT. `isBot ?? Boolean(bot_id)` looks harmless and
			// is not: with neither field present it produces `false`, which is a
			// real answer where there was no answer. `normalizeEnvelope` reads
			// exactly that distinction to decide whether a row is already
			// normalized — so a pre-normalized `{role:"assistant"}` arriving
			// through this wrapper failed the check and was re-derived to "user",
			// undoing the idempotency downstream and erasing the assistant's own
			// turns from its history. Only map `bot_id` when there IS a `bot_id`.
			isBot:
				message.isBot !== undefined
					? message.isBot
					: message.bot_id !== undefined
						? Boolean(message.bot_id)
						: undefined,
		})),
		{
			...opts,
			triggerTimestampMs:
				opts.triggerTimestampMs ??
				(opts.triggerTs ? Number.parseFloat(opts.triggerTs) * 1000 : undefined),
		},
	);
}

/**
 * Claim an event, run its turn inside a per-conversation queue, and finish
 * the durable claim according to what provably happened.
 *
 * `dedupe`/`queue` default to the module-level shared instances above, NOT a
 * fresh instance per call — see the comment on those exports.
 *
 * `queueKey`, if given, overrides the default
 * `${tenantId}:${conversationId}:${threadId || "root"}` serialization key.
 * Slack needs this: its `threadTs` is populated even for a top-level DM
 * message (it is set to that message's own ts by convention), so `threadId ||
 * "root"` cannot tell "a real thread" from "no thread" the way Discord's
 * `undefined` can — an adapter that always has SOME truthy threadId needs to
 * say so itself.
 *
 * @param {{fetchHistory:(args:any)=>Promise<any[]>,apiClient:any,eventClaims?:any,ctx:any,conversationId:string,threadId?:string,triggerMessageId:string,triggerTimestampMs?:number,fallbackText:string,eventId?:string,botUserId?:string,queueKey?:string,onStart?:()=>Promise<void>,onResult:(result:any)=>Promise<void>,onReplay?:(result:any)=>Promise<void>,dedupe?:EventDedupe,queue?:KeyedQueue}} args
 */
export async function runTurnForEvent(args) {
	const claimDedupe = args.dedupe || dedupe;
	const claimQueue = args.queue || queue;
	const eventKey = `${args.ctx.tenantId}:${args.conversationId}:${args.triggerMessageId}`;
	if (!claimDedupe.claim(eventKey)) return false;
	const dedupeKey = args.eventId
		? `${args.ctx.tenantId}:${args.eventId}`
		: eventKey;
	const conversationKey =
		args.queueKey ??
		`${args.ctx.tenantId}:${args.conversationId}:${args.threadId || "root"}`;
	/** @type {any} */
	let durable = null;
	if (args.eventClaims?.hasClaimBackend?.()) {
		try {
			durable = await args.eventClaims.claimEvent(dedupeKey);
		} catch (error) {
			// FAIL CLOSED. Treating an unreachable claim backend as "you own it"
			// turns one delivery into two billed turns — the exact failure the
			// claim exists to prevent. Release the in-memory claim so a retry
			// against a healthy backend can still run, and drop this delivery.
			claimDedupe.release(eventKey);
			throw error;
		}
		if (durable.outcome === "inflight") {
			claimDedupe.complete(eventKey);
			return false;
		}
		if (durable.outcome === "completed") {
			const onReplay = args.onReplay;
			if (durable.resultEnvelope && onReplay) {
				try {
					await claimQueue.enqueue(conversationKey, () =>
						onReplay(normalizeResult(durable.resultEnvelope)),
					);
				} catch (error) {
					// The stored answer never reached the surface. RELEASE the
					// in-memory claim so the next redelivery can try again, rather
					// than being suppressed for the whole TTL with nothing posted.
					claimDedupe.release(eventKey);
					throw error;
				}
			}
			claimDedupe.complete(eventKey);
			return false;
		}
	}
	try {
		await args.onStart?.();
	} catch (error) {
		claimDedupe.release(eventKey);
		if (durable) await args.eventClaims.releaseEvent(dedupeKey).catch(() => {});
		throw error;
	}
	const state = { dispatched: false, started: false, result: null };
	try {
		await claimQueue.enqueue(conversationKey, async () => {
			let history = normalizeEnvelope(
				await args.fetchHistory({
					conversationId: args.conversationId,
					threadId: args.threadId,
					triggerMessageId: args.triggerMessageId,
					limit: MAX_MESSAGES,
				}),
				{
					triggerMessageId: args.triggerMessageId,
					triggerTimestampMs: args.triggerTimestampMs,
					botUserId: args.botUserId,
				},
			);
			if (!history.length)
				history = [{ role: "user", content: args.fallbackText }];
			state.dispatched = true;
			const result = await args.apiClient.runAgentTurn(history, args.ctx, {
				idempotencyKey: dedupeKey,
				conversationId: args.conversationId,
			});
			state.result = result;
			state.started = true;
			await args.onResult(result);
			// Store only the shape the replay path reads, not `result` verbatim:
			// the stored envelope is a persisted contract, and it must not silently
			// change every time the API client's return type gains or drops a
			// field.
			if (durable)
				await args.eventClaims
					.completeEvent(dedupeKey, normalizeResult(result))
					.catch(() => {});
		});
		claimDedupe.complete(eventKey);
		return true;
	} catch (error) {
		// Pre-network failures — credential/config resolution inside the API
		// client, before any request left the process — are provably NOT server
		// work. Identified by a client-thrown code with NO http status (a real
		// 401 carries one); finalizing them would replay "it failed" for the
		// claim's full TTL after an operator fixes the config that caused it.
		const preflightFailure =
			error instanceof McpjamApiError &&
			error.status === undefined &&
			(error.code === "CONFIG" ||
				error.code === "NO_PROJECT" ||
				error.code === "UNAUTHORIZED");
		if (!state.dispatched || preflightFailure) {
			claimDedupe.release(eventKey);
			if (durable)
				await args.eventClaims.releaseEvent(dedupeKey).catch(() => {});
			throw error;
		}
		if (!state.started) {
			const details = /** @type {any} */ (error)?.details || {};
			const envelope = {
				reply:
					error instanceof McpjamApiError
						? error.friendlyMessage
						: "Something went wrong running that turn. Ask again to retry.",
				toolCalls: [],
				createdResources: details.createdResources || [],
				proposedActions: details.proposedActions || [],
			};
			claimDedupe.complete(eventKey);
			if (durable)
				await args.eventClaims
					.completeEvent(dedupeKey, envelope)
					.catch(() => {});
			/** @type {any} */ (error).failureEnvelope = envelope;
			throw error;
		}
		claimDedupe.complete(eventKey);
		if (durable && state.result)
			await args.eventClaims
				.completeEvent(dedupeKey, normalizeResult(state.result))
				.catch(() => {});
		throw error;
	}
}

/**
 * Small DeliverySurface adapter for callers that do not need durable claims.
 * @param {{ref:any, fetchHistory:(args:any)=>Promise<any[]>, deliver:(ref:any,result:any)=>Promise<any>, turn:(history:any[])=>Promise<any>, triggerTimestampMs?:number, limit?:number}} args
 */
export async function runTurn({
	ref,
	fetchHistory,
	deliver,
	turn,
	triggerTimestampMs,
	limit = MAX_MESSAGES,
}) {
	const history = normalizeEnvelope(
		await fetchHistory({
			...ref,
			triggerMessageId: ref.triggerMessageId,
			triggerTimestampMs,
			limit,
		}),
		{ triggerTimestampMs },
	);
	const result = await turn(history);
	const delivery = await deliver(ref, result);
	return { envelope: result, handles: delivery?.handles || [] };
}

/** @param {any} value */
function normalizeResult(value) {
	return {
		reply: typeof value?.reply === "string" ? value.reply : "",
		toolCalls: Array.isArray(value?.toolCalls) ? value.toolCalls : [],
		createdResources: Array.isArray(value?.createdResources)
			? value.createdResources
			: [],
		proposedActions: Array.isArray(value?.proposedActions)
			? value.proposedActions
			: [],
	};
}
