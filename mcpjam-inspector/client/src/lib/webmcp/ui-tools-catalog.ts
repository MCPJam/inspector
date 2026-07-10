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
        "Read the current UI Playground state (focused server, selected tool, form values, app context) without changing anything. Use this to observe before acting. Requires the playground to be open — call ui_open_playground first if it is not.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      readOnly: true,
      execute: async () => {
        // Honor readOnly: a snapshot must never navigate or mount the
        // playground. Unlike the mutating tools, it does NOT auto-open via
        // ensurePlaygroundOpen — if the handler isn't registered, tell the
        // agent to open the playground explicitly rather than changing UI
        // state behind a tool the model (and any future approval flow)
        // treats as side-effect-free.
        if (!hasInspectorCommandHandler("snapshotApp")) {
          return errorResult(
            "The UI Playground is not open, so there is nothing to snapshot. " +
              "Call ui_open_playground first, then ui_snapshot_app.",
          );
        }
        const response = await dispatchInspectorCommand({
          type: "snapshotApp",
          payload: { surface: "playground" },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
  ];
}
