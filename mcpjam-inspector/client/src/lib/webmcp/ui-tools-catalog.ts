/**
 * The v1 WebMCP UI tool catalog: hand-curated tools that let a chat agent
 * drive the MCPJam inspector. Thin wrappers over the inspector command bus —
 * `navigate`/`selectServer`/`openPlayground` via the hosted-aware actions in
 * `ui-actions.ts`, the playground-scoped commands via
 * `dispatchInspectorCommand` directly (their handlers are registered while
 * the UI Playground is mounted, so those tools auto-open the playground
 * first).
 *
 * Tool names live in the reserved `ui_` namespace (see
 * `shared/client-fulfilled-tools.ts`) and must satisfy the server-side
 * `validateUiToolEntries` boundary.
 */

import { useUIPlaygroundStore } from "@/stores/ui-playground-store";
import type {
  InspectorAppDeviceType,
  InspectorAppDisplayMode,
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
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function asOptionalObject(
  value: unknown,
): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The playground-scoped command handlers only exist while the UI Playground
 * is mounted (`use-playground-state.ts`). Open it first when needed so the
 * 2s handler-registration wait has something to wait for.
 */
async function ensurePlaygroundOpen(
  serverName?: string,
): Promise<UiToolResult | null> {
  if (useUIPlaygroundStore.getState().isPlaygroundActive) return null;
  const opened = await openPlaygroundAction(serverName);
  if (!opened.ok) {
    return errorResult(`Could not open the playground first: ${opened.error}`);
  }
  return null;
}

const DEVICE_TYPES: InspectorAppDeviceType[] = [
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
      execute: async (args) =>
        fromActionResult(
          await openPlaygroundAction(asOptionalString(args.serverName)),
        ),
    },
    {
      name: "ui_select_tool",
      description:
        "Select an MCP tool in the UI Playground and prefill its parameter form WITHOUT running it. The user sees the form fill in. Opens the playground first if needed.",
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
      execute: async (args) => {
        const toolName = asOptionalString(args.toolName);
        if (!toolName) return errorResult("Missing required 'toolName' string.");
        const serverName = asOptionalString(args.serverName);
        const notOpen = await ensurePlaygroundOpen(serverName);
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
        "REALLY runs an MCP tool against the user's connected server from the UI Playground and renders the result there. This has real side effects on the user's MCP server. Opens the playground first if needed.",
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
      execute: async (args) => {
        const toolName = asOptionalString(args.toolName);
        if (!toolName) return errorResult("Missing required 'toolName' string.");
        const serverName = asOptionalString(args.serverName);
        const notOpen = await ensurePlaygroundOpen(serverName);
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
          deviceType: { type: "string", enum: DEVICE_TYPES },
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
        const notOpen = await ensurePlaygroundOpen();
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
        "Read the current UI Playground state (focused server, selected tool, form values, app context) without changing anything. Use this to observe before acting.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      readOnly: true,
      execute: async () => {
        const notOpen = await ensurePlaygroundOpen();
        if (notOpen) return notOpen;
        const response = await dispatchInspectorCommand({
          type: "snapshotApp",
          payload: { surface: "playground" },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
  ];
}
