import {
  MCP_UI_EXTENSION_ID,
  MCP_UI_RESOURCE_MIME_TYPE,
} from "@mcpjam/sdk/browser";

/**
 * Decide whether the active host can render widget iframes for UI-bearing
 * tools.
 *
 * Today's signal: SEP-1865-conformant advertisement of the MCP UI
 * extension. Specifically, `clientCapabilities.extensions[MCP_UI_EXTENSION_ID]`
 * must be an object whose `mimeTypes` array includes
 * `"text/html;profile=mcp-app"`. The SDK default
 * (`getDefaultClientCapabilities`) ships exactly this shape, so hosts
 * that retain the SDK-default extension (Claude, ChatGPT, MCPJam, …)
 * render widgets. Hosts that explicitly strip it (Codex —
 * elicitation-only CLI) fall through to the plain tool-result row.
 *
 * **Behavioral change since PR #2169 commit 1:** previously the helper
 * accepted bare `{ extensions: { [MCP_UI_EXTENSION_ID]: {} } }` (no
 * `mimeTypes` array). After this commit such configs no longer render
 * widgets — the spec requires the mimeTypes advertisement. Hand-crafted
 * minimal capability blobs may need to add `mimeTypes: ["text/html;profile=mcp-app"]`.
 *
 * **Why `clientCapabilities` and not `hostStyle`:** users edit
 * `clientCapabilities` directly in the host editor. A user who wants to
 * model "ChatGPT but without UI support" must be able to remove the
 * extension and have the render gate honor that. Inferring from
 * `hostStyle` would silently override their edit.
 *
 * **Known capability-less Apps hosts:** Le Chat currently renders MCP Apps
 * while reporting base MCP `clientCapabilities: {}`. That is not a server
 * UI-extension advertisement, but it is a real host behavior captured from
 * `ui/initialize`. The optional `hostStyle` override lets call sites model
 * this one known host without mutating its captured wire data.
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
  opts?: { hostStyle?: string | null | undefined },
): boolean {
  if (clientCapabilities === undefined) return true;
  if (clientAdvertisesMcpApps(clientCapabilities)) return true;
  return hostStyleRendersAppsWithoutClientCapability(
    opts?.hostStyle,
    clientCapabilities,
  );
}

function hostStyleRendersAppsWithoutClientCapability(
  hostStyle: string | null | undefined,
  clientCapabilities: Record<string, unknown>,
): boolean {
  return hostStyle === "mistral" && Object.keys(clientCapabilities).length === 0;
}

/**
 * Strict predicate: does this `clientCapabilities` blob advertise the MCP
 * UI extension with the spec-required MIME type?
 *
 * Same shape check as `hostSupportsWidgetRendering` but treats `undefined`
 * as `false` — the matrix UI and the canvas's "Apps section visible" gate
 * need a concrete advertised/not-advertised answer, not the legacy
 * "no host modeled → assume capable" semantics.
 */
export function clientAdvertisesMcpApps(
  clientCapabilities: Record<string, unknown> | undefined
): boolean {
  if (!clientCapabilities) return false;
  const extensions = clientCapabilities.extensions;
  if (!isRecord(extensions)) return false;
  const uiExt = extensions[MCP_UI_EXTENSION_ID];
  if (!isRecord(uiExt)) return false;
  const mimeTypes = uiExt.mimeTypes;
  if (!Array.isArray(mimeTypes)) return false;
  return mimeTypes.includes(MCP_UI_RESOURCE_MIME_TYPE);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
