/**
 * What a chat turn accepts as ordinary MCP App context (`widgetModelContext`).
 * The server refuses a request past these with a 400, so the host refuses the
 * App's update past them when the App makes it.
 */
export const WIDGET_MODEL_CONTEXT_MAX_ENTRIES = 32;
export const WIDGET_MODEL_CONTEXT_MAX_CONTENT_BLOCKS = 32;
export const WIDGET_MODEL_CONTEXT_MAX_JSON_BYTES = 64 * 1024;
/** Every entry together. They ride in one chat request, which `/api/web/*`
 * caps at 1 MiB with the whole conversation. */
export const WIDGET_MODEL_CONTEXT_MAX_TOTAL_BYTES = 256 * 1024;
