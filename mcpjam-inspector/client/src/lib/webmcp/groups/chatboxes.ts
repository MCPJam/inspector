/**
 * Chatboxes-screen tools: publish a host's chatbox and delete it.
 *
 * Mount-scoped like the evals/registry/hosts groups: `ChatboxesTab` owns the
 * command handlers and the hosts/chatboxes they resolve against, so the tools
 * exist exactly while `/chatboxes` is mounted. Deliberate postures:
 *
 * - **Publish is host-anchored + respects the Swarms-owned dead-end.** A
 *   chatbox is the publish surface bound 1:1 to a host, so `ui_publish_chatbox`
 *   targets a host by name/id and provisions its chatbox the way the publish
 *   flow does (`ensureChatboxForHost`). It is idempotent (a host that already
 *   has a chatbox converges) and stays inside MCPJam. A standalone
 *   Journeys-owned host has NO publish surface — the handler refuses it as
 *   `unsupported_in_mode`, never back-minting one.
 * - **Delete is destructive.** `ui_delete_chatbox` removes a host's chatbox,
 *   its hosted link, and usage history.
 *
 * Read-only by design: reviewing sessions and copying the share link are human
 * actions surfaced in the snapshot, not tools. The share TOKEN never crosses
 * the transcript.
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
    "Client (host) as the client picker shows it: its name (e.g. 'Claude') or its host id. Chatboxes are 1:1 with clients.",
} as const;

export function buildChatboxesUiTools(): UiToolDefinition[] {
  return [
    {
      name: "ui_publish_chatbox",
      description:
        "Publish the chatbox for a client on the Chatboxes screen — provision its shareable chat surface if it doesn't have one yet, and select that client so the publish surface follows. Idempotent: a client that already has a chatbox just gets selected. A client that belongs to the Swarms surface has NO publish surface and is refused (use Swarms for it instead). Copying the resulting share link is a human action — check ui_snapshot_app for whether a link exists.",
      inputSchema: {
        type: "object",
        properties: { host: HOST_PROPERTY },
        required: ["host"],
        additionalProperties: false,
      },
      readOnly: false,
      // Provisions (creates) rather than wipes, and re-publishing a client that
      // already has a chatbox converges → idempotent, not destructive. Stays
      // inside MCPJam.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      execute: async (args) => {
        const host = asOptionalString(args.host);
        if (!host) {
          return errorResult("Missing required 'host' string (a client name or id).");
        }
        const response = await dispatchInspectorCommand({
          type: "publishChatbox",
          payload: { host },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: "ui_delete_chatbox",
      description:
        "Permanently delete a client's chatbox on the Chatboxes screen — its hosted share link stops working and its saved session/usage history is cleared. Irreversible; be sure the user wants this exact client's chatbox gone. Addressed by client name or id, exactly as the client picker shows it.",
      inputSchema: {
        type: "object",
        properties: { host: HOST_PROPERTY },
        required: ["host"],
        additionalProperties: false,
      },
      readOnly: false,
      // Irreversible delete → approval pill. Deleting an already-deleted chatbox
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
          return errorResult("Missing required 'host' string (a client name or id).");
        }
        const response = await dispatchInspectorCommand({
          type: "deleteChatbox",
          payload: { host },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
  ];
}
