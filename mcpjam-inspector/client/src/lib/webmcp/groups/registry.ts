/**
 * Registry-screen tools: search the mirrored connector directories, and
 * install/connect servers from those directories into the current project.
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
    "Server as shown on its card: display name (e.g. 'Asana') or a directory entry's catalog name.",
} as const;

const VARIANT_PROPERTY = {
  type: "string",
  enum: ["text", "app"],
  description:
    "Which entry of a dual-type card (Text and App) to target. Required when the card offers both.",
} as const;

function readVariant(
  value: unknown
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
        "Install a server from a connector directory on this screen into the current project and start connecting it. Catalog entries only: for a server ALREADY in the project use ui_connect_server. It finishes in the background; watch ui_snapshot_app. Some entries are reported, not started: 'authorization_required' (it would redirect the browser) and 'endpoint_choice_required' (the URL is the user's to pick). Relay those; the user clicks Connect on the card.",
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
          return errorResult(
            `'variant' must be "text" or "app" when provided.`
          );
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
          return errorResult(
            `'variant' must be "text" or "app" when provided.`
          );
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
    {
      name: "ui_search_registry_directory",
      description:
        "Search a mirrored connector directory — thousands of entries, far more than the page lists. Matches names, descriptions and tool/skill names, so 'invoice' and 'create_issue' work as well as 'Linear'. Omit 'query' to browse. Two directories, one at a time; 'source' switches, omit to keep the user's view. Drives the screen's own controls, so results are what the user sees — read them from ui_snapshot_app's `directory` block, then install with ui_connect_registry_server.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "What to search for. Omit or leave empty to browse the directory.",
          },
          source: {
            type: "string",
            enum: ["anthropic-directory", "chatgpt-directory"],
            description:
              "Which directory to browse. Omit to keep the one on screen.",
          },
          tier: {
            type: "string",
            enum: ["all", "anthropic", "partner", "community"],
            description:
              "Verification tier. Claude directory only; 'all' clears it.",
          },
        },
        required: [],
        additionalProperties: false,
      },
      readOnly: true,
      // Drives a search box and nothing else: no install, no connection, no
      // write of any kind, and running it twice leaves the same state.
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      execute: async (args) => {
        const query = asOptionalString(args.query);
        const tier = asOptionalString(args.tier);
        const source = asOptionalString(args.source);
        if (args.tier !== undefined && !tier) {
          return errorResult(
            "'tier' must be a non-empty string when provided."
          );
        }
        if (args.source !== undefined && !source) {
          return errorResult(
            "'source' must be a non-empty string when provided."
          );
        }
        const response = await dispatchInspectorCommand({
          type: "searchRegistryDirectory",
          payload: {
            ...(query ? { query } : {}),
            ...(source ? { source } : {}),
            ...(tier ? { tier } : {}),
          },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
  ];
}
