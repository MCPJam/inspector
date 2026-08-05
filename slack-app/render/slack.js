// @ts-nocheck
/**
 * Slack-only renderer. Core produces semantic parts; this adapter owns
 * mrkdwn escaping, Slack mentions, links, and Block Kit payloads.
 */
export function escapeSlackText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderSlack(content) {
  const text = (content?.parts || [])
    .map((part) => {
      if (typeof part === 'string') return escapeSlackText(part);
      if (part?.mention) return `<@${part.mention}>`;
      if (part?.link) return `<${part.link.url}|${escapeSlackText(part.link.label || part.link.url)}>`;
      if (part?.code) return `\`${escapeSlackText(String(part.code)).replace(/`/g, '\\`')}\``;
      return '';
    })
    .join('');
  const emoji =
    { success: ':white_check_mark:', warning: ':warning:', error: ':x:', info: ':information_source:' }[
      content?.severity
    ] || '';
  return { text: `${emoji ? `${emoji} ` : ''}${text}`, blocks: content?.blocks || undefined };
}

export function createSlackDelivery(client) {
  return {
    async deliver(ref, content) {
      const payload = renderSlack(content);
      const response = await client.chat.postMessage({
        channel: ref.conversationId || ref.channelId,
        thread_ts: ref.threadId,
        ...payload,
      });
      return { handles: response?.ts ? [{ id: response.ts, channelId: response.channel || ref.conversationId }] : [] };
    },
    async edit(handle, content) {
      return client.chat.update({ channel: handle.channelId, ts: handle.id, ...renderSlack(content) });
    },
    async uploadImages(ref, images) {
      return client.files.uploadV2({ channel_id: ref.conversationId || ref.channelId, file: images });
    },
  };
}
