/**
 * Opt-in client-side debug logger for the MCP Apps render pipeline.
 *
 * Enable in DevTools:
 *   localStorage.setItem("mcpjam:debug-mcp-apps", "1");
 *   // (then reload)
 *
 * Disable:
 *   localStorage.removeItem("mcpjam:debug-mcp-apps");
 *
 * Wired at three boundaries to bisect "MCP Apps stopped rendering" reports:
 *   - `part-switch.tsx` after the widget-gate decision (detection side)
 *   - `mcp-apps/fetch-widget-content.ts` after the HTTP fetch (fetch side)
 *   - any other site that wants to chime in
 *
 * Stays quiet by default — when the flag is off, the function is a no-op and
 * the call site costs one `localStorage.getItem` per invocation.
 */
const FLAG_KEY = "mcpjam:debug-mcp-apps";

function isEnabled(): boolean {
  // Guarded for SSR / environments without localStorage.
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage?.getItem(FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

export function debugMcpApps(label: string, data: Record<string, unknown>): void {
  if (!isEnabled()) return;
  // eslint-disable-next-line no-console -- intentional opt-in user instrumentation
  console.log(`[mcp-apps-debug] ${label}`, data);
}
