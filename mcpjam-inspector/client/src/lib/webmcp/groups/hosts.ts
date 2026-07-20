/**
 * Hosts-screen tools: create a host from a client template, open a host's
 * editor, set which servers a host attaches, delete a host, and duplicate one.
 *
 * Mount-scoped like the registry/evals/swarms groups: `HostsTab` owns the
 * command handlers and the host list / project servers they resolve against,
 * so the tools exist exactly while the Hosts hub is mounted. Two deliberate
 * postures:
 *
 * - **Prefill-over-commit for config.** A host config is high-entropy (model,
 *   system prompt, behavior flags, protocol, appearance across focus tabs), so
 *   there is NO one-shot "update host config" tool. `ui_open_host_editor`
 *   navigates the human to the host's editor to change any of that — the
 *   `ui_open_server_form` / `ui_open_eval_suite_form` precedent. What DOES
 *   commit directly is genuinely low-entropy: create-from-template (name +
 *   template id), the attached-server LIST (existing project server names),
 *   delete, and duplicate.
 * - **System prompt is user content.** It never appears in a tool input, a
 *   tool result, or the snapshot — creation seeds it from the template, and
 *   editing it happens in the editor the human opened.
 *
 * Only `ui_delete_host` is destructive (irreversible). Setting servers is a
 * reversible set-to-list; creating/duplicating stay inside MCPJam.
 */

import type { UiToolDefinition } from "../ui-tools-registry";
import {
  commandResponseToActionResult,
  dispatchInspectorCommand,
} from "../ui-actions";
import { asOptionalString, errorResult, fromActionResult } from "./shared";

const HOST_PROPERTY = {
  type: "string",
  description:
    "Host as the Hosts list shows it: its name (e.g. 'Claude') or its host id.",
} as const;

/** Coerce an args array of server names into a clean string[] or reject. */
function readServerNames(
  value: unknown,
): { ok: true; names: string[] } | { ok: false } {
  if (!Array.isArray(value)) return { ok: false };
  const names: string[] = [];
  for (const entry of value) {
    const name = asOptionalString(entry);
    if (!name) return { ok: false };
    names.push(name);
  }
  return { ok: true, names };
}

export function buildHostsUiTools(): UiToolDefinition[] {
  return [
    {
      name: "ui_create_host",
      description:
        "Create a new host on the Hosts screen from a client TEMPLATE. Takes a display name and, optionally, the template's catalog id (e.g. 'claude', 'cursor', 'mcpjam'); omit it for the default template. Low-entropy — the config is seeded from the template exactly as the New Client dialog does — so this creates the host directly, selects it, and opens its editor. To change the host's model, system prompt, or behavior afterward, use ui_open_host_editor.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Display name for the new host.",
          },
          template: {
            type: "string",
            description:
              "Optional catalog template id to seed from (e.g. 'claude', 'cursor'). Defaults to the standard template.",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
      readOnly: false,
      // Creates a new host each time (not idempotent) from a template; stays
      // inside MCPJam.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      // A successful create opens the new host's editor.
      mayNavigate: true,
      execute: async (args) => {
        const name = asOptionalString(args.name);
        if (!name) {
          return errorResult("Missing required 'name' string.");
        }
        const template = asOptionalString(args.template);
        if (args.template !== undefined && template === undefined) {
          return errorResult(
            "'template' must be a non-empty string when provided.",
          );
        }
        const response = await dispatchInspectorCommand({
          type: "createHost",
          payload: { name, ...(template ? { template } : {}) },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: "ui_open_host_editor",
      description:
        "Open a host's editor on the Hosts screen for the user. This is the way to change host CONFIG — its model, system prompt, tool-approval and tool-discovery behavior, protocol, and appearance are high-entropy and edited in the editor's focus tabs, not committed from here. Selects the host and navigates to its canvas; it changes nothing on its own.",
      inputSchema: {
        type: "object",
        properties: { host: HOST_PROPERTY },
        required: ["host"],
        additionalProperties: false,
      },
      readOnly: false,
      // Navigates + selects; no data changes, and opening the same editor
      // twice lands in the same place.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      mayNavigate: true,
      execute: async (args) => {
        const host = asOptionalString(args.host);
        if (!host) {
          return errorResult("Missing required 'host' string.");
        }
        const response = await dispatchInspectorCommand({
          type: "openHostEditor",
          payload: { host },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: "ui_set_host_servers",
      description:
        "Set which of the project's MCP servers a host has attached, by name. 'servers' is the COMPLETE list of existing project server names the host should have — servers not listed are detached, and unknown names are rejected without changing anything. Reversible (reattach any time). To add a server to the project first, use the Connect-screen server tools.",
      inputSchema: {
        type: "object",
        properties: {
          host: HOST_PROPERTY,
          servers: {
            type: "array",
            items: { type: "string" },
            description:
              "Complete set of existing project server names to attach (empty array detaches all).",
          },
        },
        required: ["host", "servers"],
        additionalProperties: false,
      },
      readOnly: false,
      // Set-to-list against existing project servers → reversible, and a retry
      // with the same list converges rather than accumulating.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      execute: async (args) => {
        const host = asOptionalString(args.host);
        if (!host) {
          return errorResult("Missing required 'host' string.");
        }
        const servers = readServerNames(args.servers);
        if (!servers.ok) {
          return errorResult(
            "'servers' must be an array of non-empty project server names.",
          );
        }
        const response = await dispatchInspectorCommand({
          type: "setHostServers",
          payload: { host, servers: servers.names },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: "ui_delete_host",
      description:
        "Permanently delete a host, including its configuration and sessions. Irreversible — be sure the user wants this exact host gone. The host is addressed by name or id, exactly as shown on the Hosts screen.",
      inputSchema: {
        type: "object",
        properties: { host: HOST_PROPERTY },
        required: ["host"],
        additionalProperties: false,
      },
      readOnly: false,
      // Irreversible delete → approval pill. Deleting an already-deleted host
      // fails cleanly rather than deleting something else.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      execute: async (args) => {
        const host = asOptionalString(args.host);
        if (!host) {
          return errorResult("Missing required 'host' string.");
        }
        const response = await dispatchInspectorCommand({
          type: "deleteHost",
          payload: { host },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: "ui_duplicate_host",
      description:
        "Duplicate an existing host into a new one with the same configuration. Optionally names the copy; otherwise the backend derives a name. The new host is selected and opened. Low-entropy, so this commits directly.",
      inputSchema: {
        type: "object",
        properties: {
          host: HOST_PROPERTY,
          name: {
            type: "string",
            description: "Optional name for the duplicate.",
          },
        },
        required: ["host"],
        additionalProperties: false,
      },
      readOnly: false,
      // Creates a new copy each time (not idempotent); stays inside MCPJam.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      // A successful duplicate opens the copy's editor.
      mayNavigate: true,
      execute: async (args) => {
        const host = asOptionalString(args.host);
        if (!host) {
          return errorResult("Missing required 'host' string.");
        }
        const name = asOptionalString(args.name);
        if (args.name !== undefined && name === undefined) {
          return errorResult("'name' must be a non-empty string when provided.");
        }
        const response = await dispatchInspectorCommand({
          type: "duplicateHost",
          payload: { host, ...(name ? { name } : {}) },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
  ];
}
