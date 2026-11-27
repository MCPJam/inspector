/**
 * `classifyAppsBridgeMessage`: one message between an MCP Apps view and its
 * host → the observable feature ids it shows. These ids never appear on the
 * wire between MCPJam and the server, so only the browser's widget host can
 * observe them (engineering spec v0.4, "3. Observed").
 *
 * Pure and browser-safe. Like `classifyFrame`, it reads method names and a
 * few structural fields and returns ids only.
 */

import { SERVER_FEATURE_CATALOG } from "./catalog/index.js";

export type BridgeDirection = "host-to-ui" | "ui-to-host";

/**
 * One logged bridge message. `method` is the method the widget host logged it
 * under: the message's own method, or for a response the method of the
 * request it answers when the host correlated it ("result" otherwise).
 */
export interface BridgeMessage {
  direction: BridgeDirection;
  method: string;
  message: unknown;
}

/**
 * The observable ids only the Apps bridge can show: MCP Apps rows and the
 * OpenAI host extensions a view uses, derived from the catalog.
 */
export const APPS_BRIDGE_FEATURE_IDS: ReadonlySet<string> = new Set(
  SERVER_FEATURE_CATALOG.filter(
    (entry) =>
      entry.assessment.observable &&
      (entry.family === "mcp-apps" ||
        (entry.family === "third-party-experimental" && entry.owner === "host"))
  ).map((entry) => entry.id)
);

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(value: unknown, key: string): Rec | undefined {
  if (!isRecord(value)) return undefined;
  const entry = value[key];
  return isRecord(entry) ? entry : undefined;
}

function hasMeta(value: unknown, key: string): boolean {
  const meta = recordAt(value, "_meta");
  return meta !== undefined && meta[key] !== undefined;
}

const VIEW_REQUESTS = new Set([
  "ui/open-link",
  "ui/message",
  "ui/update-model-context",
  "ui/request-display-mode",
]);

const HOST_NOTIFICATIONS = new Set([
  "ui/notifications/tool-input",
  "ui/notifications/tool-input-partial",
  "ui/notifications/tool-result",
  "ui/notifications/tool-cancelled",
  "ui/notifications/host-context-changed",
  "ui/notifications/size-changed",
  "ui/resource-teardown",
]);

const APP_TOOL_METHODS = new Set(["tools/call", "tools/list"]);

function hasTextBlock(result: unknown): boolean {
  const content = isRecord(result) ? result.content : undefined;
  return (
    Array.isArray(content) &&
    content.some((block) => isRecord(block) && block.type === "text")
  );
}

/** A request or notification the view sent to the host. */
function classifyViewMessage(
  method: string,
  params: unknown,
  out: Set<string>
) {
  if (method === "tools/call") out.add("apps.app-tools-call");
  if (method === "resources/read") {
    out.add("apps.app-resources-read");
    if (hasMeta(params, "openai/resource")) out.add("openai.file-resources");
  }
  if (VIEW_REQUESTS.has(method)) out.add("apps.view-requests");
  if (method === "ui/message" && hasMeta(params, "openai/message"))
    out.add("openai.message");
  if (method === "notifications/message" || method === "ping")
    out.add("apps.view-notifications");
  if (
    method === "ui/download-file" ||
    method === "ui/notifications/request-teardown"
  )
    out.add("apps.download-file-teardown");
  if (method === "notifications/tools/list_changed")
    out.add("apps.app-provided-tools");
  if (method === "openai/resources/write") out.add("openai.file-resources");
  if (method === "openai/files/open") out.add("openai.files");
  if (method === "ui/initialize") {
    const capabilities = recordAt(params, "appCapabilities");
    const modes = capabilities?.availableDisplayModes;
    if (Array.isArray(modes) && modes.length > 0) out.add("apps.display-modes");
    if (capabilities?.tools !== undefined) out.add("apps.app-provided-tools");
  }
}

/**
 * Feature ids one bridge message shows. `requestMethod` is the method of the
 * request a host response answers, when the caller kept it.
 */
export function classifyAppsBridgeMessage(
  entry: BridgeMessage,
  requestMethod?: string
): string[] {
  const out = new Set<string>();
  const message = isRecord(entry.message) ? entry.message : undefined;
  const ownMethod =
    typeof message?.method === "string" ? message.method : undefined;
  const isResponse =
    ownMethod === undefined &&
    message?.id !== undefined &&
    (message.result !== undefined || message.error !== undefined);
  if (entry.direction === "ui-to-host") {
    if (ownMethod) classifyViewMessage(ownMethod, message?.params, out);
    // The view answering the host's call to its own tools.
    else if (isResponse && APP_TOOL_METHODS.has(entry.method))
      out.add("apps.app-provided-tools");
  } else if (isResponse) {
    if (
      requestMethod === "ui/update-model-context" &&
      hasMeta(message?.result, "openai/modelContext")
    )
      out.add("openai.model-context");
  } else {
    // A host request or notification, or the host's record of calling one
    // of the view's own tools (logged without a JSON-RPC envelope).
    const method = ownMethod ?? entry.method;
    if (HOST_NOTIFICATIONS.has(method)) out.add("apps.host-notifications");
    if (
      method === "ui/notifications/tool-result" &&
      hasTextBlock(message?.params)
    )
      out.add("apps.text-fallback");
    if (APP_TOOL_METHODS.has(method)) out.add("apps.app-provided-tools");
  }
  return [...out].filter((id) => APPS_BRIDGE_FEATURE_IDS.has(id));
}
