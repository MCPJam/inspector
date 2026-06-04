/**
 * SEP-1865 app-only-tool predicate.
 *
 * Pure leaf — no runtime imports. Lives in `host-config/` so the
 * `@mcpjam/sdk/host-config/internal` barrel can re-export it without
 * pulling Node-only deps (e.g. `ai`, `@modelcontextprotocol/client`)
 * that `mcp-client-manager/tool-converters.ts` brings in.
 *
 * `tool-converters.ts` re-exports `isAppOnlyTool` from this file so
 * existing external import paths continue to work.
 */

/**
 * Checks whether a tool is app-only per SEP-1865 (`_meta.ui.visibility = ["app"]`).
 *
 * Per SEP-1865, tools whose visibility does not include `"model"` MUST NOT be
 * included in the agent's tool list. They remain callable from the iframe/app
 * via `tools/call`, but the model never sees them.
 *
 * @param toolMeta - The tool's `_meta` field from listTools result
 * @returns true if the tool is app-only (must be hidden from the model)
 */
export function isAppOnlyTool(
  toolMeta: Record<string, unknown> | undefined,
): boolean {
  if (!toolMeta) return false;
  const visibility = (toolMeta as { ui?: { visibility?: unknown } }).ui
    ?.visibility;
  if (!Array.isArray(visibility)) return false;
  return visibility.length === 1 && visibility[0] === "app";
}
