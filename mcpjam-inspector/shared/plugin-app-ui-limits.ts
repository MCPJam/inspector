/**
 * Size bounds for a plugin extension App's UI, shared by the server routes
 * that read the `ui://` resource (App activation, form previews) and the client
 * that receives it inside a JSON reply.
 *
 * Real Apps ship single-file HTML well past 1 MB: OpenAI's own Bits & Bolts
 * example inlines its viewer at about 1.1 MB, and renders in ChatGPT and Codex.
 * Inline (model-invoked) MCP Apps carry no cap at all, so the entrypoint path
 * must not refuse what the same server's inline App renders.
 */
export const PLUGIN_APP_UI_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * The client's cap on a reply that carries that UI. JSON escaping can grow the
 * HTML (quotes, backslashes, control characters), so the reply gets twice the
 * UI bound plus room for the rest of the payload.
 */
export const PLUGIN_APP_REPLY_MAX_BYTES =
  2 * PLUGIN_APP_UI_MAX_BYTES + 1024 * 1024;
