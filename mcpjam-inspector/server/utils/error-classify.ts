export function classifyError(error: unknown): string {
  if (!error) return "unknown";
  if (error instanceof Error) {
    if (error.name === "AbortError") return "abort";
    if (error.message.includes("Connection closed")) return "connection_closed";
    if (error.name === "McpError") return "mcp_error";
    return "unhandled_exception";
  }
  return "unknown";
}

export function classifyWidgetError(error: unknown, hint?: string): string {
  if (hint === "resource_missing") return "resource_missing";
  if (hint === "html_missing") return "html_missing";
  if (hint === "template_invalid") return "template_invalid";
  if (hint === "read_resource_failed") return "read_resource_failed";
  if (error instanceof Error) {
    if (error.message.includes("readResource")) return "read_resource_failed";
  }
  return "unknown";
}

export function classifyTunnelError(error: unknown, hint?: string): string {
  if (hint === "fetch_ngrok_token_failed") return "fetch_ngrok_token_failed";
  if (hint === "ngrok_create_failed") return "ngrok_create_failed";
  if (hint === "convex_record_failed") return "convex_record_failed";
  return "unknown";
}
