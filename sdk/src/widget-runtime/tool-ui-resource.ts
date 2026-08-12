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
 * Upstream signals a malformed URI with a plain `Error` carrying this prefix —
 * it has no error subclass or code to match on, so the message is the only
 * discriminator available. `tool-ui-resource.test.ts` pins the real dependency
 * against this prefix, so an ext-apps upgrade that reworded it fails there
 * rather than silently turning every detection surface into "no app UI".
 */
const MALFORMED_URI_MESSAGE_PREFIX = "Invalid UI resource URI:";

function isMalformedUriError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith(MALFORMED_URI_MESSAGE_PREFIX)
  );
}

/**
 * The tool's declared `ui://` resource URI, or `null` when it declares none or
 * declares one that is malformed. Resolves both the nested
 * `_meta.ui.resourceUri` and the deprecated flat `_meta["ui/resourceUri"]`.
 *
 * Only the malformed-URI throw is absorbed. Anything else upstream raises is a
 * real fault — a changed contract, a bug in `app-bridge` — and propagates, so
 * a detection regression stays visible instead of reading as "no app UI".
 */
export function resolveToolUiResourceUri(
  toolMeta: Record<string, unknown> | undefined,
): string | null {
  try {
    return getToolUiResourceUri({ _meta: toolMeta }) ?? null;
  } catch (error) {
    if (isMalformedUriError(error)) return null;
    throw error;
  }
}
