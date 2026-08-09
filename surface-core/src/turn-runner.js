// @ts-nocheck — not yet adopted by slack-app. Typed as each module is
// migrated off its slack-app twin; the marker tracks that remaining work.
const MAX_MESSAGES = 50;
const MAX_MESSAGE_CHARS = 8_000;
const MAX_MESSAGE_BYTES = 8_192;
const MAX_TOTAL_MESSAGE_BYTES = 98_304;

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
	constructor(options = {}) {
		this.ttlMs = options.ttlMs ?? 30 * 60_000;
		this.now = options.now ?? Date.now;
		this.seen = new Map();
	}
	claim(key) {
		this.sweep();
		if (this.seen.has(key)) return false;
		this.seen.set(key, Infinity);
		return true;
	}
	complete(key) {
		if (this.seen.has(key)) this.seen.set(key, this.now());
	}
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
		this.chains = new Map();
	}
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

/** @param {Array<Record<string,any>>} raw @param {{triggerMessageId?:string,triggerTimestampMs?:number,botUserId?:string}} opts */
export function normalizeEnvelope(raw, opts) {
	const triggerMs = opts.triggerTimestampMs;
	const messages = [];
	for (const message of raw) {
		const content = String(message.content ?? message.text ?? "").trim();
		if (!content) continue;
		const timestampMs = Number(message.timestampMs);
		if (
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

/** Compatibility name used by the Slack adapter and characterization tests. */
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
		opts,
	);
}

/** @param {{fetchHistory:(args:any)=>Promise<any[]>,delivery:any,apiClient:any,eventClaims?:any,ctx:any,conversationId:string,threadId?:string,triggerMessageId:string,triggerTimestampMs?:number,fallbackText:string,eventId?:string,botUserId?:string,onStart?:()=>Promise<void>,onResult:(result:any)=>Promise<void>,onReplay?:(result:any)=>Promise<void>,dedupe?:EventDedupe,queue?:KeyedQueue}} args */
export async function runTurnForEvent(args) {
	const dedupe = args.dedupe || new EventDedupe();
	const queue = args.queue || new KeyedQueue();
	const eventKey = `${args.ctx.tenantId}:${args.conversationId}:${args.triggerMessageId}`;
	if (!dedupe.claim(eventKey)) return false;
	const dedupeKey = args.eventId
		? `${args.ctx.tenantId}:${args.eventId}`
		: eventKey;
	let durable = null;
	if (args.eventClaims?.hasClaimBackend?.()) {
		durable = await args.eventClaims.claimEvent(dedupeKey);
		if (durable.outcome === "inflight") {
			dedupe.complete(eventKey);
			return false;
		}
		if (durable.outcome === "completed") {
			if (durable.resultEnvelope && args.onReplay)
				await queue.enqueue(
					`${args.ctx.tenantId}:${args.conversationId}:${args.threadId || "root"}`,
					() => args.onReplay(normalizeResult(durable.resultEnvelope)),
				);
			dedupe.complete(eventKey);
			return false;
		}
	}
	try {
		await args.onStart?.();
	} catch (error) {
		dedupe.release(eventKey);
		if (durable) await args.eventClaims.releaseEvent(dedupeKey).catch(() => {});
		throw error;
	}
	const state = { dispatched: false, started: false, result: null };
	try {
		await queue.enqueue(
			`${args.ctx.tenantId}:${args.conversationId}:${args.threadId || "root"}`,
			async () => {
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
				if (durable)
					await args.eventClaims
						.completeEvent(dedupeKey, result)
						.catch(() => {});
			},
		);
		dedupe.complete(eventKey);
		return true;
	} catch (error) {
		if (!state.dispatched) {
			dedupe.release(eventKey);
			if (durable)
				await args.eventClaims.releaseEvent(dedupeKey).catch(() => {});
			throw error;
		}
		if (!state.started) {
			const details = error?.details || {};
			const envelope = {
				reply:
					error?.structuredContent?.parts?.[0] ||
					"Something went wrong running that turn. Ask again to retry.",
				toolCalls: [],
				createdResources: details.createdResources || [],
				proposedActions: details.proposedActions || [],
			};
			dedupe.complete(eventKey);
			if (durable)
				await args.eventClaims
					.completeEvent(dedupeKey, envelope)
					.catch(() => {});
			error.failureEnvelope = envelope;
			throw error;
		}
		dedupe.complete(eventKey);
		if (durable && state.result)
			await args.eventClaims
				.completeEvent(dedupeKey, state.result)
				.catch(() => {});
		throw error;
	}
}

/** Small DeliverySurface adapter for callers that do not need durable claims. */
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
