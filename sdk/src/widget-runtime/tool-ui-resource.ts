/**
 * SEP-1865 UI resource URI resolution.
 *
 * `getToolUiResourceUri` throws when a tool declares a `resourceUri` that is
 * present but not a `ui://` string — the empty string included. That metadata
 * is third-party: `_meta` reaches us verbatim from whatever MCP server the user
 * connected, so one nonconforming tool takes down every surface that asks "is
 * this an app?". A server advertising `ui.resourceUri: ""` blanked `/servers`
 * behind the route error boundary (INSPECTOR-CLIENT-227).
 *
 * Detection is a question, not an assertion: "does this tool declare a usable
 * app UI?" A malformed URI answers no. Resolving to `null` lets callers branch
 * on that answer instead of unwinding through them.
 */
import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";

/**
 * The tool's declared `ui://` resource URI, or `null` when it declares none or
 * declares one that is malformed. Resolves both the nested
 * `_meta.ui.resourceUri` and the deprecated flat `_meta["ui/resourceUri"]`.
 */
export function resolveToolUiResourceUri(
  toolMeta: Record<string, unknown> | undefined,
): string | null {
  try {
    return getToolUiResourceUri({ _meta: toolMeta }) ?? null;
  } catch {
    // Upstream owns the definition of a valid URI. Whatever it rejects is not
    // something any caller here can render, so it is simply "no app UI".
    return null;
  }
}
