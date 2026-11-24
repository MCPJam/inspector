/** Plugin behavior belongs to the MCP client, independently of its agent loop. */
export function pluginRuntimeProfile(config: {
  harness?: string | null;
} | null | undefined): "codex" | "chatgpt" {
  return config?.harness === "codex" ? "codex" : "chatgpt";
}
