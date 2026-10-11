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
 * The most a UTF-8 byte of HTML can grow under `JSON.stringify`: a control
 * character is one byte and serializes as the six-byte `\u00XX`, and a lone
 * surrogate counts as three bytes and serializes as `\uXXXX`.
 */
const JSON_ESCAPE_MAX_EXPANSION = 6;

/**
 * The client's cap on a reply that carries that UI: the worst-case escaped
 * HTML plus room for the rest of the payload, so any UI the server accepts
 * also fits the reply.
 */
export const PLUGIN_APP_REPLY_MAX_BYTES =
  JSON_ESCAPE_MAX_EXPANSION * PLUGIN_APP_UI_MAX_BYTES + 1024 * 1024;
