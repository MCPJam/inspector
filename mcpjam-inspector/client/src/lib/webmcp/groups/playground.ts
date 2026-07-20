/**
 * Playground tools: open the playground, prefill a tool form, and execute a
 * tool. Global today ("global"-kind in the manifests): each mutating tool
 * auto-opens the playground when its handler isn't mounted, so it is
 * reachable from any route.
 */

import type { UiToolDefinition } from "../ui-tools-registry";
import {
  commandResponseToActionResult,
  dispatchInspectorCommand,
  openPlaygroundAction,
} from "../ui-actions";
import {
  asOptionalString,
  ensurePlaygroundOpen,
  errorResult,
  fromActionResult,
} from "./shared";

function asOptionalObject(
  value: unknown,
): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function buildPlaygroundUiTools(): UiToolDefinition[] {
  return [
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
  ];
}
