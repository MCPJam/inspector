/**
 * Connect-screen tools: add, connect, disconnect, and remove MCP servers.
 * Global today ("global"-kind in the manifests): every one of these
 * navigates the user to the Connect screen itself before mutating, so it is
 * reachable — and visible — from any route.
 */

import { hasInspectorCommandHandler } from "@/lib/inspector-command-handlers";
import type { InspectorCommandType } from "@/shared/inspector-command.js";
import type { UiToolDefinition, UiToolResult } from "../ui-tools-registry";
import {
  commandResponseToActionResult,
  dispatchInspectorCommand,
  navigateAction,
} from "../ui-actions";
import { asOptionalString, errorResult, fromActionResult } from "./shared";

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

// Server draft fields, shared. NO env/headers: those routinely hold API
// keys and bearer tokens, and everything here crosses the chat transcript.
// A server needing secret env/headers is set up by prefilling the rest via
// ui_open_server_form and letting the user type the secrets into the form.
const SERVER_DRAFT_PROPERTIES = {
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
} as const;

/** ui_add_server SAVES, so it needs at least a name. */
const ADD_SERVER_SCHEMA = {
  type: "object",
  properties: SERVER_DRAFT_PROPERTIES,
  required: ["name"],
  additionalProperties: false,
} as const;

/** ui_open_server_form OPENS a form to finish; everything is optional. */
const OPEN_SERVER_FORM_SCHEMA = {
  type: "object",
  properties: SERVER_DRAFT_PROPERTIES,
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
    // Only carry `args` when every element is already a string — coercing
    // arbitrary values with String() would seed the draft with junk like
    // "[object Object]"; a malformed array is dropped and the user fills it in.
    ...(Array.isArray(args.args) &&
    (args.args as unknown[]).every((a) => typeof a === "string")
      ? { args: args.args as string[] }
      : {}),
  };
}

/** A prefill draft with no fields set — so the command opens a blank form. */
function readServerPrefill(args: Record<string, unknown>) {
  const draft = readServerDraft(args);
  const entries = Object.entries(draft).filter(([k, v]) =>
    k === "name" ? v !== "" : true,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * Land the user on the Connect screen before a server mutation runs there.
 *
 * The connect/disconnect/remove handlers are App-level and work from any
 * route, so without this the agent could disconnect a server while the user
 * is looking at the Playground — the change lands somewhere they can't see
 * it. The whole premise of this surface is that the user watches you work,
 * so take them to where the work happens first.
 */
async function navigateToConnect(): Promise<UiToolResult | null> {
  const navigated = await navigateAction("servers");
  if (!navigated.ok) {
    return errorResult(`Could not open the Connect screen: ${navigated.error}`);
  }
  return null;
}

/**
 * A Connect-screen tool that acts on one named server: navigate there so the
 * user sees it, then dispatch. Factored because connect/disconnect/remove are
 * the same shape and Chrome's guidance warns that near-duplicate tool bodies
 * drift apart.
 */
function connectScreenServerTool(config: {
  name: string;
  description: string;
  commandType: "connectServer" | "disconnectServer" | "removeServer";
  verb: string;
  annotations: NonNullable<UiToolDefinition["annotations"]>;
}): UiToolDefinition {
  return {
    name: config.name,
    description: config.description,
    inputSchema: {
      type: "object",
      properties: {
        serverName: {
          type: "string",
          description: `Server to ${config.verb}.`,
        },
      },
      required: ["serverName"],
      additionalProperties: false,
    },
    readOnly: false,
    annotations: config.annotations,
    mayNavigate: true,
    execute: async (args) => {
      const serverName = asOptionalString(args.serverName);
      if (!serverName) {
        return errorResult("Missing required 'serverName' string.");
      }
      const onConnect = await navigateToConnect();
      if (onConnect) return onConnect;
      const response = await dispatchInspectorCommand({
        type: config.commandType,
        payload: { serverName },
      });
      return fromActionResult(commandResponseToActionResult(response));
    },
  };
}

export function buildServersUiTools(): UiToolDefinition[] {
  return [
    {
      name: "ui_open_server_form",
      description:
        "Open the Add-server form on the Connect screen, optionally prefilled, and leave it for the user to review and submit. Use this when the user should make the final call, when you don't have everything a server needs, or when a server needs a secret API key or header (the user types those into the form). To add a fully-specified server outright, use ui_add_server.",
      inputSchema: OPEN_SERVER_FORM_SCHEMA,
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
        // Prefill is optional and partial — a blank open is valid, so send a
        // `draft` only when there's something to prefill.
        const prefill = readServerPrefill(args);
        const response = await dispatchInspectorCommand({
          type: "openServerForm",
          payload: prefill ? { draft: prefill } : {},
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: "ui_add_server",
      description:
        "Add an MCP server to the current project and save it, without connecting. The user is taken to the Connect screen and sees it appear. Connect it afterwards with ui_connect_server. Fails if a server with that name already exists, or if it would need a secret env var or header — use ui_open_server_form for those so the user can enter the secret.",
      inputSchema: ADD_SERVER_SCHEMA,
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
        // Land the user on Connect so the new server appears where they're
        // looking, not silently behind whatever screen they're on.
        const onConnect = await navigateToConnect();
        if (onConnect) return onConnect;
        const response = await dispatchInspectorCommand({
          type: "addServer",
          payload: { draft },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    connectScreenServerTool({
      name: "ui_connect_server",
      description:
        "Connect a saved MCP server, and report what happened. Use it for a server that is disconnected or failed. If the server needs the user to authorize it, this reports 'authorization_required' rather than authorizing on their behalf — relay that and let them click Authorize.",
      commandType: "connectServer",
      verb: "connect",
      // Non-destructive, but it opens a session to an external server.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    }),
    connectScreenServerTool({
      name: "ui_disconnect_server",
      description:
        "Disconnect a connected MCP server, leaving its configuration in place. Reconnect it later with ui_connect_server.",
      commandType: "disconnectServer",
      verb: "disconnect",
      // Reversible by construction: the config survives, only the session ends.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    }),
    connectScreenServerTool({
      name: "ui_remove_server",
      description:
        "Delete an MCP server from the current project, including its saved configuration. This cannot be undone from chat — the user would have to add the server again.",
      commandType: "removeServer",
      verb: "remove",
      // The one destructive Connect tool: it deletes configuration the user
      // may not be able to reconstruct. Confirms even with approvals off.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    }),
  ];
}
