/**
 * Slack-only renderer. Core produces semantic parts; this adapter owns
 * mrkdwn escaping, Slack mentions, links, and Block Kit payloads.
 */

/**
 * A short, user-facing Slack message for an API failure.
 *
 * The emoji are RENDERING, which is why this lives here and not on the shared
 * error class: Discord and Teams show the same failure with their own visual
 * vocabulary, and a `:satellite:` baked into the transport would leak into
 * both as literal text.
 *
 * @param {{ code?: string }} error
 * @returns {string}
 */
export function friendlyMessage(error) {
  if (error?.code === 'RATE_LIMITED') {
    return ":hourglass_flowing_sand: I'm at capacity right now — give it a minute and try again.";
  }
  if (error?.code === 'TIMEOUT') {
    return ':hourglass: That took longer than I allow for one reply. Try breaking the request into smaller steps.';
  }
  if (error?.code === 'SERVER_UNREACHABLE') {
    // A backend blip must never be reported as an auth problem: the user
    // would go and re-link an account that was already fine.
    return ":satellite: I can't reach MCPJam right now. Try again in a moment.";
  }
  if (error?.code === 'UNAUTHORIZED') {
    return ':link: I need you to connect your MCPJam account before I can do that.';
  }
  if (error?.code === 'FORBIDDEN') {
    // The clamp and the delegated mint both enforce project access. The
    // common cause is a thread bound to a project the replier can't reach.
    return ":lock: You don't have access to the project this thread is working in.";
  }
  return ':warning: Something went wrong talking to MCPJam. Try again in a moment.';
}
/** @param {unknown} value */
export function escapeSlackText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * @param {import('@mcpjam/surface-core').StructuredContent | null | undefined} content
 * @returns {{ text: string, blocks?: Array<Record<string, unknown>> }}
 */
export function renderSlack(content) {
  const text = (content?.parts || [])
    .map((/** @type {any} */ part) => {
      if (typeof part === 'string') return escapeSlackText(part);
      if (part?.mention) return `<@${part.mention}>`;
      if (part?.link) return `<${part.link.url}|${escapeSlackText(part.link.label || part.link.url)}>`;
      if (part?.code) return `\`${escapeSlackText(String(part.code)).replace(/`/g, '\\`')}\``;
      return '';
    })
    .join('');
  /** @type {Record<string, string>} */
  const emoji = {
    success: ':white_check_mark:',
    warning: ':warning:',
    error: ':x:',
    info: ':information_source:',
  };
  const icon = (content?.severity ? emoji[content.severity] : undefined) || '';
  return { text: `${icon ? `${icon} ` : ''}${text}`, blocks: content?.blocks || undefined };
}

/**
 * The Slack DeliverySurface. One semantic response is one Slack message here;
 * surfaces with a hard length cap return several handles instead.
 * @param {any} client a Bolt WebClient
 */
export function createSlackDelivery(client) {
  return {
    /** @param {any} ref @param {any} content */
    async deliver(ref, content) {
      const payload = renderSlack(content);
      const response = await client.chat.postMessage({
        channel: ref.conversationId || ref.channelId,
        thread_ts: ref.threadId,
        ...payload,
      });
      return { handles: response?.ts ? [{ id: response.ts, channelId: response.channel || ref.conversationId }] : [] };
    },
    /** @param {{id: string, channelId: string}} handle @param {any} content */
    async edit(handle, content) {
      return client.chat.update({ channel: handle.channelId, ts: handle.id, ...renderSlack(content) });
    },
    /** @param {any} ref @param {any} images */
    async uploadImages(ref, images) {
      return client.files.uploadV2({ channel_id: ref.conversationId || ref.channelId, file: images });
    },
  };
}
