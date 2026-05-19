import { MCP_UI_EXTENSION_ID } from "@mcpjam/sdk/browser";

/**
 * Decide whether the active host can render widget iframes for UI-bearing
 * tools.
 *
 * Today's signal: the host's `clientCapabilities` blob advertises the MCP
 * UI extension (`extensions["io.modelcontextprotocol/ui"]`). Hosts that
 * keep the SDK-default extension (Claude, ChatGPT, MCPJam, …) render
 * widgets; hosts that explicitly strip it (Codex — elicitation-only CLI)
 * fall through to the plain tool-result row.
 *
 * **Why `clientCapabilities` and not `hostStyle`:** users edit
 * `clientCapabilities` directly in the host editor. A user who wants to
 * model "ChatGPT but without UI support" must be able to remove the
 * extension and have the render gate honor that. Inferring from
 * `hostStyle` would silently override their edit.
 *
 * **Transitional gap:** the OpenAI Apps SDK (`window.openai`) is a
 * separate rendering protocol not yet represented by a capability flag.
 * In practice every Apps-SDK host we ship today (ChatGPT, Copilot)
 * KEEPS the MCP UI extension in their template, so the extension check
 * covers them. Codex strips the extension and is correctly excluded.
 * A future explicit "window.openai" flag on `HostConfigInputV2` will
 * subsume this branch — see the TODO at the OR site in the caller.
 *
 * **`undefined` semantics:** when called with `undefined` (no active host
 * in scope), returns `true`. Surfaces without `activeHost` plumbing
 * (legacy chat tabs, tests) preserve their historical "tool metadata is
 * the only gate" behavior. The intent is to RESTRICT capable hosts'
 * rendering when they opt out, not to break surfaces that don't model
 * a host at all.
 */
export function hostSupportsWidgetRendering(
  clientCapabilities: Record<string, unknown> | undefined,
): boolean {
  if (clientCapabilities === undefined) return true;
  const extensions = clientCapabilities.extensions;
  if (!isRecord(extensions)) return false;
  return MCP_UI_EXTENSION_ID in extensions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
