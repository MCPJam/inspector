/**
 * The v1 WebMCP UI tool catalog: hand-curated tools that let a chat agent
 * drive the MCPJam inspector. Thin wrappers over the inspector command bus —
 * `navigate`/`selectServer`/`openPlayground` via the hosted-aware actions in
 * `ui-actions.ts`, the playground-scoped commands via
 * `dispatchInspectorCommand` directly (their handlers are registered while
 * the /playground surface is mounted). The mutating playground tools
 * auto-open the playground first when the handler is absent; the read-only
 * `ui_snapshot_app` deliberately does not — it errors instead, so a
 * side-effect-free tool never changes UI state.
 *
 * Tool names live in the reserved `ui_` namespace (see
 * `shared/client-fulfilled-tools.ts`) and must satisfy the server-side
 * `validateUiToolEntries` boundary.
 *
 * REGISTRATION POLICY — global, deliberately NOT contextual. Chrome's WebMCP
 * guidance suggests registering tools only when useful in the current page
 * state, but that targets content sites where an absent tool is meaningless.
 * Here every tool is reachable from any state via the auto-open fallback,
 * and contextual registration would drop the playground tools from the
 * advertised set whenever the playground is closed — so a one-shot prompt
 * like "open the playground and run X" (the agent panel's core flow) would
 * burn an extra model turn waiting for re-advertisement (`snapshotForChatBody`
 * drains per POST). The registry fully supports scoped registration
 * (`registerUiTool` with an abort signal; `shippedNames` makes mid-session
 * unregister hang-safe) if a future surface-scoped tool actually needs it.
 */

import { hasInspectorCommandHandler } from "@/lib/inspector-command-handlers";
import type {
  InspectorAppDeviceType,
  InspectorAppDisplayMode,
  InspectorCommandType,
  SetAppContextInspectorCommand,
} from "@/shared/inspector-command.js";
import type { UiToolDefinition, UiToolResult } from "./ui-tools-registry";
import {
  commandResponseToActionResult,
  dispatchInspectorCommand,
  listUiNavigationTargets,
  navigateAction,
  openPlaygroundAction,
  selectServerAction,
  type UiActionResult,
} from "./ui-actions";

/** Keep serialized results well under context-bloating sizes. */
const MAX_RESULT_CHARS = 16 * 1024;

function clampText(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}… [truncated]`;
}

function okResult(data: unknown): UiToolResult {
  let text: string;
  try {
    text = JSON.stringify(data === undefined ? { ok: true } : { ok: true, data });
  } catch {
    text = JSON.stringify({ ok: true, note: "Result was not serializable." });
  }
  return { content: [{ type: "text", text: clampText(text) }] };
}

function errorResult(message: string): UiToolResult {
  return {
    content: [{ type: "text", text: clampText(message) }],
    isError: true,
  };
}

function fromActionResult(result: UiActionResult): UiToolResult {
  return result.ok ? okResult(result.data) : errorResult(result.error);
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asOptionalObject(
  value: unknown,
): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The playground-scoped command handlers only exist while the playground
 * surface is mounted (`usePlaygroundState` in `PlaygroundTab` on
 * `/playground`). Gate on the HANDLER being registered — not on UI store
 * flags, which track a different surface (`isPlaygroundActive` follows the
 * Views-tab preview) — and open the playground first when it is missing.
 * The bus's 2s late-registration wait bridges the mount after navigation.
 */
async function ensurePlaygroundOpen(
  commandType: InspectorCommandType,
  serverName?: string,
): Promise<UiToolResult | null> {
  if (hasInspectorCommandHandler(commandType)) return null;
  const opened = await openPlaygroundAction(serverName);
  if (!opened.ok) {
    return errorResult(`Could not open the playground first: ${opened.error}`);
  }
  return null;
}

/**
 * The Connect screen owns `openServerForm` (the Add-server modal's open
 * state and the billing gate are its own), so that command only exists
 * while `/servers` is mounted. Navigate first; the bus's 2s
 * late-registration wait bridges the mount.
 */
async function ensureConnectOpen(
  commandType: InspectorCommandType,
): Promise<UiToolResult | null> {
  if (hasInspectorCommandHandler(commandType)) return null;
  const navigated = await navigateAction("servers");
  if (!navigated.ok) {
    return errorResult(`Could not open the Connect screen: ${navigated.error}`);
  }
  return null;
}

/** Shared JSON Schema for an agent-authored server draft. */
const SERVER_DRAFT_SCHEMA = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "Name for the server, e.g. 'Excalidraw'.",
    },
    transport: {
      type: "string",
      enum: ["http", "stdio"],
      description: "Defaults to 'http'.",
    },
    url: {
      type: "string",
      description: "HTTP servers only. Hosted deployments require https.",
    },
    command: {
      type: "string",
      description: "STDIO servers only: the executable, with no arguments.",
    },
    args: {
      type: "array",
      items: { type: "string" },
      description: "STDIO servers only: arguments, one per entry.",
    },
    env: {
      type: "object",
      description: "STDIO servers only: environment variables.",
    },
    headers: {
      type: "object",
      description: "HTTP servers only: request headers.",
    },
  },
  required: ["name"],
  additionalProperties: false,
} as const;

function readServerDraft(args: Record<string, unknown>) {
  return {
    name: asOptionalString(args.name) ?? "",
    ...(asOptionalString(args.transport)
      ? { transport: asOptionalString(args.transport) as "http" | "stdio" }
      : {}),
    ...(asOptionalString(args.url) ? { url: asOptionalString(args.url) } : {}),
    ...(asOptionalString(args.command)
      ? { command: asOptionalString(args.command) }
      : {}),
    ...(Array.isArray(args.args)
      ? { args: (args.args as unknown[]).map((a) => String(a)) }
      : {}),
    ...(args.env && typeof args.env === "object"
      ? { env: args.env as Record<string, string> }
      : {}),
    ...(args.headers && typeof args.headers === "object"
      ? { headers: args.headers as Record<string, string> }
      : {}),
  };
}

const DEVICE_TYPES: InspectorAppDeviceType[] = [
  "fill",
  "mobile",
  "tablet",
  "desktop",
  "custom",
];
const DISPLAY_MODES: InspectorAppDisplayMode[] = [
  "inline",
  "pip",
  "fullscreen",
];

export function buildUiToolsCatalog(): UiToolDefinition[] {
  return [
    {
      name: "ui_navigate",
      description:
        `Navigate the MCPJam inspector to a page. The user sees the page change. Valid targets: ${listUiNavigationTargets().join(", ")}. ` +
        "Deep paths like 'evals/suite/<suiteId>' are allowed.",
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description:
              "Page to open: a tab name (e.g. 'playground') or deep path (e.g. 'evals/suite/<id>').",
          },
        },
        required: ["target"],
        additionalProperties: false,
      },
      readOnly: false,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        // NOT idempotent: a normal navigation pushes a browser-history entry
        // even when the destination is unchanged, so repeated calls DO have
        // an additional effect. Advertising idempotent would invite a native
        // agent to retry freely and pile up history.
        idempotentHint: false,
        openWorldHint: false,
      },
      mayNavigate: true,
      execute: async (args) => {
        const target = asOptionalString(args.target);
        if (!target) return errorResult("Missing required 'target' string.");
        return fromActionResult(await navigateAction(target));
      },
    },
    {
      name: "ui_select_server",
      description:
        "Select a connected MCP server in the MCPJam inspector by name, making it the focused server for the tools/resources views. Fails if the server is unknown or disconnected.",
      inputSchema: {
        type: "object",
        properties: {
          serverName: { type: "string", description: "Server name to focus." },
        },
        required: ["serverName"],
        additionalProperties: false,
      },
      readOnly: false,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      execute: async (args) => {
        const serverName = asOptionalString(args.serverName);
        if (!serverName) {
          return errorResult("Missing required 'serverName' string.");
        }
        return fromActionResult(await selectServerAction(serverName));
      },
    },
    {
      name: "ui_open_playground",
      description:
        "Open the MCPJam UI Playground (visible to the user), optionally focusing one server. Prefer calling this before ui_select_tool / ui_execute_tool / ui_snapshot_app.",
      inputSchema: {
        type: "object",
        properties: {
          serverName: {
            type: "string",
            description: "Optional server to focus the playground on.",
          },
        },
        additionalProperties: false,
      },
      readOnly: false,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      mayNavigate: true,
      execute: async (args) =>
        fromActionResult(
          await openPlaygroundAction(asOptionalString(args.serverName)),
        ),
    },
    {
      name: "ui_select_tool",
      description:
        "Prefill (do not run) an MCP tool's parameter form in the UI Playground — the safe, reversible counterpart of ui_execute_tool. The user sees the form fill in and can review or run it themselves. Opens the playground first if needed.",
      inputSchema: {
        type: "object",
        properties: {
          toolName: { type: "string", description: "MCP tool to select." },
          serverName: {
            type: "string",
            description: "Server the tool belongs to (defaults to focused).",
          },
          parameters: {
            type: "object",
            description: "Parameter values to prefill.",
          },
        },
        required: ["toolName"],
        additionalProperties: false,
      },
      readOnly: false,
      // Prefills a form the user still has to run: mutates UI state, but
      // nothing about it is destructive and it never leaves the browser.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      // Auto-opens the playground when its handler isn't mounted — from a
      // non-playground route that is a navigation.
      mayNavigate: true,
      execute: async (args) => {
        const toolName = asOptionalString(args.toolName);
        if (!toolName) return errorResult("Missing required 'toolName' string.");
        const serverName = asOptionalString(args.serverName);
        const notOpen = await ensurePlaygroundOpen("selectTool", serverName);
        if (notOpen) return notOpen;
        const response = await dispatchInspectorCommand({
          type: "selectTool",
          payload: {
            surface: "playground",
            toolName,
            ...(serverName ? { serverName } : {}),
            ...(asOptionalObject(args.parameters)
              ? { parameters: asOptionalObject(args.parameters) }
              : {}),
          },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: "ui_execute_tool",
      description:
        "Execute an MCP tool against the user's connected server from the UI Playground and render the result there. This REALLY runs the tool — real side effects on the user's MCP server. Prefer ui_select_tool when the user has not clearly asked to run it. Opens the playground first if needed.",
      inputSchema: {
        type: "object",
        properties: {
          toolName: { type: "string", description: "MCP tool to execute." },
          serverName: {
            type: "string",
            description: "Server the tool belongs to (defaults to focused).",
          },
          parameters: {
            type: "object",
            description: "Arguments to call the tool with.",
          },
        },
        required: ["toolName"],
        additionalProperties: false,
      },
      readOnly: false,
      // The only UI tool with effects outside the browser: it runs an
      // arbitrary third-party MCP tool whose own destructiveness is unknown
      // here. `destructiveHint: true` is what makes it confirm even in the
      // default (non-strict) approval mode — the pessimistic read is the
      // correct one until per-call target-annotation pass-through exists.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      // Its result comes from a third-party MCP server — externally sourced,
      // so a browser-native agent should treat it as untrusted. `openWorldHint`
      // (MCP) doesn't convey that to a WebMCP agent; `untrustedContentHint`
      // (WebMCP) does. Native mirror only.
      nativeUntrustedContentHint: true,
      // Auto-opens the playground when its handler isn't mounted — from a
      // non-playground route that is a navigation.
      mayNavigate: true,
      execute: async (args) => {
        const toolName = asOptionalString(args.toolName);
        if (!toolName) return errorResult("Missing required 'toolName' string.");
        const serverName = asOptionalString(args.serverName);
        const notOpen = await ensurePlaygroundOpen("executeTool", serverName);
        if (notOpen) return notOpen;
        const response = await dispatchInspectorCommand({
          type: "executeTool",
          payload: {
            surface: "playground",
            toolName,
            ...(serverName ? { serverName } : {}),
            ...(asOptionalObject(args.parameters)
              ? { parameters: asOptionalObject(args.parameters) }
              : {}),
          },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: "ui_set_app_context",
      description:
        "Change the MCPJam playground's emulated app context: theme (light/dark), device type, widget display mode, locale, or time zone. The user sees the change immediately.",
      inputSchema: {
        type: "object",
        properties: {
          theme: { type: "string", enum: ["light", "dark"] },
          deviceType: {
            type: "string",
            enum: DEVICE_TYPES,
            description:
              "'fill' = the default, fits the panel; the rest are fixed-size presets.",
          },
          displayMode: { type: "string", enum: DISPLAY_MODES },
          locale: {
            type: "string",
            description: "BCP 47 locale, e.g. 'en-US'.",
          },
          timeZone: {
            type: "string",
            description: "IANA time zone, e.g. 'Europe/Paris'.",
          },
        },
        additionalProperties: false,
      },
      readOnly: false,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      // Auto-opens the playground when its handler isn't mounted — from a
      // non-playground route that is a navigation.
      mayNavigate: true,
      execute: async (args) => {
        const payload: SetAppContextInspectorCommand["payload"] = {};
        const theme = asOptionalString(args.theme);
        if (theme === "light" || theme === "dark") payload.theme = theme;
        const deviceType = asOptionalString(args.deviceType);
        if (DEVICE_TYPES.includes(deviceType as InspectorAppDeviceType)) {
          payload.deviceType = deviceType as InspectorAppDeviceType;
        }
        const displayMode = asOptionalString(args.displayMode);
        if (DISPLAY_MODES.includes(displayMode as InspectorAppDisplayMode)) {
          payload.displayMode = displayMode as InspectorAppDisplayMode;
        }
        const locale = asOptionalString(args.locale);
        if (locale) payload.locale = locale;
        const timeZone = asOptionalString(args.timeZone);
        if (timeZone) payload.timeZone = timeZone;
        if (Object.keys(payload).length === 0) {
          return errorResult(
            "Provide at least one of: theme, deviceType, displayMode, locale, timeZone.",
          );
        }
        const notOpen = await ensurePlaygroundOpen("setAppContext");
        if (notOpen) return notOpen;
        const response = await dispatchInspectorCommand({
          type: "setAppContext",
          payload,
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: "ui_snapshot_app",
      description:
        "Read what the user currently sees — the open screen, the servers they have selected and their connection status, plus the detailed state of any screen that reports it (e.g. the Playground's selected tool, form values, and last result). Changes nothing. Use it to observe before acting. Pass 'surface' to read one screen; omit it for the whole app.",
      inputSchema: {
        type: "object",
        properties: {
          surface: {
            type: "string",
            description:
              "Optional screen id to read on its own, e.g. 'playground'. Omit for the whole app.",
          },
        },
        additionalProperties: false,
      },
      readOnly: true,
      // The only read-only tool in the catalog: never gates, in either
      // approval mode. That exemption is only sound because it observes
      // whatever is already open and never mounts a surface to read it.
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      execute: async (args) => {
        const surface = asOptionalString(args.surface);
        const response = await dispatchInspectorCommand({
          type: "snapshotApp",
          payload: surface ? { surface: surface as never } : {},
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },

    // --- Connect screen -------------------------------------------------
    {
      name: "ui_open_server_form",
      description:
        "Open the Add-server form on the Connect screen, optionally prefilled, and leave it for the user to review and submit. Use this when the user should make the final call — or when they haven't given you everything a server needs. To add a server outright, use ui_add_server.",
      inputSchema: SERVER_DRAFT_SCHEMA,
      readOnly: false,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      mayNavigate: true,
      execute: async (args) => {
        const notOpen = await ensureConnectOpen("openServerForm");
        if (notOpen) return notOpen;
        const draft = readServerDraft(args);
        const response = await dispatchInspectorCommand({
          type: "openServerForm",
          payload: { draft: draft.name ? draft : { ...draft, name: "" } },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: "ui_add_server",
      description:
        "Add an MCP server to the current project and save it, without connecting. The user sees it appear on the Connect screen. Connect it afterwards with ui_connect_server. Fails if a server with that name already exists.",
      inputSchema: SERVER_DRAFT_SCHEMA,
      readOnly: false,
      // Additive: it creates a new server and refuses to overwrite one.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      mayNavigate: true,
      execute: async (args) => {
        const draft = readServerDraft(args);
        if (!draft.name) return errorResult("Missing required 'name' string.");
        const response = await dispatchInspectorCommand({
          type: "addServer",
          payload: { draft },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: "ui_connect_server",
      description:
        "Connect a saved MCP server, and report what happened. Use it for a server that is disconnected or failed. If the server needs the user to authorize it, this reports 'authorization_required' rather than authorizing on their behalf — relay that and let them click Authorize.",
      inputSchema: {
        type: "object",
        properties: {
          serverName: { type: "string", description: "Server to connect." },
        },
        required: ["serverName"],
        additionalProperties: false,
      },
      readOnly: false,
      // Non-destructive, but it opens a session to an external server.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      mayNavigate: true,
      execute: async (args) => {
        const serverName = asOptionalString(args.serverName);
        if (!serverName) {
          return errorResult("Missing required 'serverName' string.");
        }
        const response = await dispatchInspectorCommand({
          type: "connectServer",
          payload: { serverName },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: "ui_disconnect_server",
      description:
        "Disconnect a connected MCP server, leaving its configuration in place. Reconnect it later with ui_connect_server.",
      inputSchema: {
        type: "object",
        properties: {
          serverName: { type: "string", description: "Server to disconnect." },
        },
        required: ["serverName"],
        additionalProperties: false,
      },
      readOnly: false,
      // Reversible by construction: the config survives, only the session ends.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      mayNavigate: true,
      execute: async (args) => {
        const serverName = asOptionalString(args.serverName);
        if (!serverName) {
          return errorResult("Missing required 'serverName' string.");
        }
        const response = await dispatchInspectorCommand({
          type: "disconnectServer",
          payload: { serverName },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: "ui_remove_server",
      description:
        "Delete an MCP server from the current project, including its saved configuration. This cannot be undone from chat — the user would have to add the server again.",
      inputSchema: {
        type: "object",
        properties: {
          serverName: { type: "string", description: "Server to remove." },
        },
        required: ["serverName"],
        additionalProperties: false,
      },
      readOnly: false,
      // The one destructive Connect tool: it deletes configuration the user
      // may not be able to reconstruct. Confirms even with approvals off.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      mayNavigate: true,
      execute: async (args) => {
        const serverName = asOptionalString(args.serverName);
        if (!serverName) {
          return errorResult("Missing required 'serverName' string.");
        }
        const response = await dispatchInspectorCommand({
          type: "removeServer",
          payload: { serverName },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
  ];
}
