/**
 * Registry-screen tools: install/connect, disconnect, and star servers from
 * the public registry catalog.
 *
 * The first mount-scoped group (the Connect-screen tools are "global"-kind
 * and self-navigate; these do not): `RegistryTab` owns the command handlers
 * and the catalog they resolve against, so the tools exist exactly while
 * `/registry` is mounted. No ensure-open helper here on purpose — a dispatch
 * with the surface unmounted gets the bus's `unsupported_in_mode` after its
 * 2s wait, which tells the model to `ui_navigate` to the registry first.
 */

import type { UiToolDefinition } from "../ui-tools-registry";
import {
  commandResponseToActionResult,
  dispatchInspectorCommand,
} from "../ui-actions";
import { asOptionalString, errorResult, fromActionResult } from "./shared";

const SERVER_NAME_PROPERTY = {
  type: "string",
  description:
    "Registry server as shown on its card: display name (e.g. 'Asana') or registry name (e.g. 'com.asana.mcp').",
} as const;

const VARIANT_PROPERTY = {
  type: "string",
  enum: ["text", "app"],
  description:
    "Which entry of a dual-type card (Text and App) to target. Required when the card offers both.",
} as const;

function readVariant(
  value: unknown,
): { ok: true; variant?: "text" | "app" } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (value === "text" || value === "app") return { ok: true, variant: value };
  return { ok: false };
}

export function buildRegistryUiTools(): UiToolDefinition[] {
  return [
    {
      name: "ui_connect_registry_server",
      description:
        "Install a server from the public MCP registry's catalog into the current project and start connecting it. Registry catalog entries only — to connect a server ALREADY added to the project, use ui_connect_server instead. Connection finishes in the background; observe progress with ui_snapshot_app. If the server requires OAuth, this reports 'authorization_required' without starting the flow — relay that and let the user click Connect on the card to authorize on screen.",
      inputSchema: {
        type: "object",
        properties: {
          serverName: SERVER_NAME_PROPERTY,
          variant: VARIANT_PROPERTY,
        },
        required: ["serverName"],
        additionalProperties: false,
      },
      readOnly: false,
      // Installs and opens a session to an external third-party server.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      // A successful quick-connect auto-redirects to the playground.
      mayNavigate: true,
      execute: async (args) => {
        const serverName = asOptionalString(args.serverName);
        if (!serverName) {
          return errorResult("Missing required 'serverName' string.");
        }
        const variant = readVariant(args.variant);
        if (!variant.ok) {
          return errorResult(`'variant' must be "text" or "app" when provided.`);
        }
        const response = await dispatchInspectorCommand({
          type: "connectRegistryServer",
          payload: {
            serverName,
            ...(variant.variant ? { variant: variant.variant } : {}),
          },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: "ui_disconnect_registry_server",
      description:
        "Disconnect a server that was installed from the registry and remove it from the current project. The catalog entry stays in the registry, so it can be reinstalled any time with ui_connect_registry_server. For a project server that did not come from the registry, use ui_disconnect_server.",
      inputSchema: {
        type: "object",
        properties: {
          serverName: SERVER_NAME_PROPERTY,
          variant: VARIANT_PROPERTY,
        },
        required: ["serverName"],
        additionalProperties: false,
      },
      readOnly: false,
      // Reversible by construction: the registry keeps the entry; only the
      // session and the project's install go away.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      execute: async (args) => {
        const serverName = asOptionalString(args.serverName);
        if (!serverName) {
          return errorResult("Missing required 'serverName' string.");
        }
        const variant = readVariant(args.variant);
        if (!variant.ok) {
          return errorResult(`'variant' must be "text" or "app" when provided.`);
        }
        const response = await dispatchInspectorCommand({
          type: "disconnectRegistryServer",
          payload: {
            serverName,
            ...(variant.variant ? { variant: variant.variant } : {}),
          },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: "ui_toggle_registry_star",
      description:
        "Star or unstar a registry server for the user. 'starred' is the explicit target state — true stars the card, false unstars it, and a card already in that state is left unchanged.",
      inputSchema: {
        type: "object",
        properties: {
          serverName: SERVER_NAME_PROPERTY,
          starred: {
            type: "boolean",
            description: "Target state: true to star, false to unstar.",
          },
        },
        required: ["serverName", "starred"],
        additionalProperties: false,
      },
      readOnly: false,
      // Set-to-state (not a blind toggle), so a retry cannot flip it back.
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
        if (typeof args.starred !== "boolean") {
          return errorResult("Missing required 'starred' boolean.");
        }
        const response = await dispatchInspectorCommand({
          type: "toggleRegistryStar",
          payload: { serverName, starred: args.starred },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
  ];
}
