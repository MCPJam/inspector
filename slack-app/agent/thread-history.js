/**
 * Fetch RAW history rows for a Slack trigger, for the core's turn-runner to
 * normalize exactly once (see surface-core/src/turn-runner.js's contract
 * comment on `normalizeEnvelope` — a pre-normalized row silently erases the
 * assistant's own turns from its history).
 *
 * Channel threads use `conversations.replies`; DM top-level messages use
 * `conversations.history` (a DM has no thread until someone starts one).
 * History is newest-first from that endpoint and must be reversed.
 *
 * @param {import('@slack/web-api').WebClient} client
 * @param {{ channelId: string, threadTs: string, triggerTs: string, isThread: boolean, botUserId?: string, limit: number }} args
 */
export async function fetchThreadHistory(client, args) {
  /** @type {Array<Record<string, any>>} */
  let raw = [];
  if (args.isThread) {
    const result = await client.conversations.replies({
      channel: args.channelId,
      ts: args.threadTs,
      limit: 200,
    });
    raw = result.messages ?? [];
  } else {
    const result = await client.conversations.history({
      channel: args.channelId,
      latest: args.triggerTs,
      inclusive: true,
      limit: args.limit,
    });
    raw = (result.messages ?? []).slice().reverse();
  }
  return raw.map((message) => ({
    content: message.text,
    timestampMs: message.ts ? Number.parseFloat(message.ts) * 1000 : undefined,
    authorId: message.user,
    isBot: Boolean(message.bot_id) || (args.botUserId !== undefined && message.user === args.botUserId),
  }));
}
