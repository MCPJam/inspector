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

/**
 * Envelope shape each view dereferences unconditionally. Field-level
 * optionality (spec-optional fields) is the views' job; this catches a
 * tagged payload whose top-level structure is missing or mistyped, so the
 * app can fall back to its error box instead of crashing mid-render.
 */
const WIDGET_PAYLOAD_GUARDS: Record<
  PlatformWidgetView,
  (payload: Record<string, unknown>) => boolean
> = {
  servers: (payload) =>
    isRecord(payload.project) && Array.isArray(payload.servers),
  eval_suites: (payload) =>
    isRecord(payload.project) && Array.isArray(payload.items),
  eval_suite_runs: (payload) =>
    isRecord(payload.project) &&
    isRecord(payload.suite) &&
    Array.isArray(payload.items),
  eval_run: (payload) => isRecord(payload.project) && isRecord(payload.run),
  eval_run_iterations: (payload) =>
    isRecord(payload.project) && Array.isArray(payload.items),
  chatboxes: (payload) =>
    isRecord(payload.project) && Array.isArray(payload.items),
  chatbox: (payload) =>
    isRecord(payload.project) && isRecord(payload.chatbox),
};

/**
 * The `widget` tag of a tool result's structured content — but only when the
 * payload also carries the envelope that view renders.
 */
export function getPlatformWidgetView(
  payload: unknown
): PlatformWidgetView | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  const value = (payload as { widget?: unknown }).widget;
  // Own-property check: `in` would also accept prototype keys such as
  // "toString" and index inherited members of the guard map.
  if (
    typeof value !== "string" ||
    !Object.hasOwn(PLATFORM_WIDGET_RESOURCE_URIS, value)
  ) {
    return undefined;
  }

  const view = value as PlatformWidgetView;
  return WIDGET_PAYLOAD_GUARDS[view](payload) ? view : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
