import { runByMode } from "@/lib/apis/mode-client";
import { authFetch } from "@/lib/session-token";

/**
 * Client wrapper for the local headless widget-render route
 * (`POST /api/mcp/widget-render`). It mounts a server's MCP App tool result in
 * the eval browser harness (real Chromium running the production host bridge)
 * and returns a render verdict + screenshot — the "observed" apps-lane signal
 * for host compatibility.
 *
 * Local-Inspector only: the route is mounted solely when `!HOSTED_MODE`, so the
 * hosted branch throws (callers gate the affordance behind `!isHostedMode()`).
 */

/** Mirrors the server's `WidgetRenderStatus` (mcp-app-browser-harness.ts). */
export type WidgetRenderStatus =
  | "rendered"
  | "no_ui_resource"
  | "resource_read_failed"
  | "mount_failed"
  | "bridge_timeout"
  | "render_error"
  | "blank_screenshot"
  | "screenshot_failed"
  | "browser_unavailable";

/** Mirrors `buildWidgetRenderResponseBody` (widget-render-core.ts). */
export interface WidgetRenderResult {
  status: WidgetRenderStatus;
  resourceUri?: string;
  bridgeInitialized?: boolean;
  screenshotBase64?: string;
  consoleErrors?: string[];
  blockedRequests?: string[];
  elapsedMs: number;
  /** e.g. "npx playwright install chromium" when `browser_unavailable`. */
  hint?: string;
}

export interface RenderWidgetInput {
  serverId: string;
  toolName: string;
  /** Inject the `window.openai` shim (for ChatGPT/Copilot-style hosts). */
  injectOpenAiCompat?: boolean;
  viewport?: { width: number; height: number };
}

async function localPost<T>(path: string, body: unknown): Promise<T> {
  const response = await authFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data as T;
}

export async function renderWidget(
  input: RenderWidgetInput,
): Promise<WidgetRenderResult> {
  return runByMode({
    local: () =>
      localPost<WidgetRenderResult>("/api/mcp/widget-render", {
        serverId: input.serverId,
        toolName: input.toolName,
        injectOpenAiCompat: input.injectOpenAiCompat ?? false,
        ...(input.viewport ? { viewport: input.viewport } : {}),
      }),
    hosted: () => {
      throw new Error("Live render is only available in the local inspector.");
    },
  });
}
