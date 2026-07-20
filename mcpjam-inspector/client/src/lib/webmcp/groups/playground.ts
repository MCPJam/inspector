/**
 * Playground tools: open the playground, prefill a tool form, execute a tool,
 * and drive the chat composer (model, system prompt, reset, stop). Global
 * ("global"-kind in the manifests): each mutating tool auto-opens the
 * playground when its handler isn't mounted, so it is reachable from any route.
 *
 * The chat-composer tools EXTEND this global catalog rather than forming a
 * mount-scoped surface group, because the playground manifest is `kind:
 * "global"` — the tools stay advertised app-wide and open the playground on
 * demand, exactly like `ui_select_tool`. Their handlers read the chat session
 * through the playground agent-controls bridge (see `use-playground-state`).
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
    {
      name: "ui_select_model",
      description:
        "Select the model the MCPJam UI Playground chat uses. Pass a model identifier as the picker shows it (its id, e.g. 'claude-sonnet-5', or its display name). Resolves against the available models; an unknown one is rejected. The user sees the model chip update. Opens the playground first if needed.",
      inputSchema: {
        type: "object",
        properties: {
          model: {
            type: "string",
            description: "Model id or display name to select.",
          },
        },
        required: ["model"],
        additionalProperties: false,
      },
      readOnly: false,
      // Switches the composer's model — a reversible UI selection the user
      // watches happen; nothing leaves the browser.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      mayNavigate: true,
      execute: async (args) => {
        const model = asOptionalString(args.model);
        if (!model) return errorResult("Missing required 'model' string.");
        const notOpen = await ensurePlaygroundOpen("selectModel");
        if (notOpen) return notOpen;
        const response = await dispatchInspectorCommand({
          type: "selectModel",
          payload: { model },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: "ui_set_system_prompt",
      description:
        "Set the MCPJam UI Playground chat's system prompt to the given text (the user is directing it). Pass an empty string to clear it. The prompt applies to the next turn; the user sees the system-prompt control reflect it. Opens the playground first if needed.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "The system prompt text to apply. Empty string clears it.",
          },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      readOnly: false,
      // Replaces a composer setting the user watches change. The prompt is a
      // user-directed INPUT; results/snapshots never echo it back beyond
      // presence/length.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      mayNavigate: true,
      execute: async (args) => {
        // Free text, so accept it verbatim — including the empty string, which
        // is the explicit "clear the prompt" request and must NOT error.
        const prompt = typeof args.prompt === "string" ? args.prompt : undefined;
        if (prompt === undefined) {
          return errorResult("Missing required 'prompt' string.");
        }
        const notOpen = await ensurePlaygroundOpen("setSystemPrompt");
        if (notOpen) return notOpen;
        const response = await dispatchInspectorCommand({
          type: "setSystemPrompt",
          payload: { prompt },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: "ui_reset_chat",
      description:
        "Start a new / reset the MCPJam UI Playground chat, clearing the current conversation. This LOSES the conversation — it cannot be undone. Runs the same reset the Clear-chat button does. Opens the playground first if needed.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      readOnly: false,
      // Irreversible: the conversation is gone. `destructiveHint: true` shows
      // the confirmation pill even in the default approval mode — the pill IS
      // the confirmation, so the handler performs the reset directly. Each
      // reset starts a FRESH chat session, so a retry is not a no-op →
      // idempotentHint false (an interrupted retry spawns another session).
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      mayNavigate: true,
      execute: async () => {
        const notOpen = await ensurePlaygroundOpen("resetChat");
        if (notOpen) return notOpen;
        const response = await dispatchInspectorCommand({
          type: "resetChat",
          payload: {},
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: "ui_stop_generation",
      description:
        "Stop an in-flight response in the MCPJam UI Playground chat. Succeeds as a no-op if nothing is generating. Opens the playground first if needed.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      readOnly: false,
      // Halts streaming — reversible (just send again) and browser-local.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      mayNavigate: true,
      execute: async () => {
        const notOpen = await ensurePlaygroundOpen("stopGeneration");
        if (notOpen) return notOpen;
        const response = await dispatchInspectorCommand({
          type: "stopGeneration",
          payload: {},
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
  ];
}
