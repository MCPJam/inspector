/**
 * Contract between the worker's widget-backed tools and the single MCP Apps
 * bundle (`src/ui/app.tsx`) they all share. The worker tags each widget
 * tool's payload with `widget: <view>` so the app can route to the right
 * view; resource URIs stay one-per-tool because hosts cache templates by
 * URI. Types only flow in from `@mcpjam/sdk/platform`, so this module stays
 * safe to import from the Vite-bundled widget.
 */
import type {
  GetChatboxResult,
  GetEvalRunResult,
  ListChatboxesResult,
  ListEvalRunIterationsResult,
  ListEvalSuiteRunsResult,
  ListEvalSuitesResult,
  ShowServersPayload,
} from "@mcpjam/sdk/platform";

export type PlatformWidgetPayloadMap = {
  servers: ShowServersPayload;
  eval_suites: ListEvalSuitesResult;
  eval_suite_runs: ListEvalSuiteRunsResult;
  eval_run: GetEvalRunResult;
  eval_run_iterations: ListEvalRunIterationsResult;
  chatboxes: ListChatboxesResult;
  chatbox: GetChatboxResult;
};

export type PlatformWidgetView = keyof PlatformWidgetPayloadMap;

export const PLATFORM_WIDGET_RESOURCE_URIS: Record<PlatformWidgetView, string> =
  {
    servers: "ui://mcpjam/show-servers.html",
    eval_suites: "ui://mcpjam/eval-suites.html",
    eval_suite_runs: "ui://mcpjam/eval-suite-runs.html",
    eval_run: "ui://mcpjam/eval-run.html",
    eval_run_iterations: "ui://mcpjam/eval-run-iterations.html",
    chatboxes: "ui://mcpjam/chatboxes.html",
    chatbox: "ui://mcpjam/chatbox.html",
  };

export function tagPlatformWidgetPayload(
  view: PlatformWidgetView,
  payload: object
): object {
  return { ...payload, widget: view };
}

/** The `widget` tag of a tool result's structured content, when recognized. */
export function getPlatformWidgetView(
  payload: unknown
): PlatformWidgetView | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }

  const value = (payload as { widget?: unknown }).widget;
  return typeof value === "string" && value in PLATFORM_WIDGET_RESOURCE_URIS
    ? (value as PlatformWidgetView)
    : undefined;
}
