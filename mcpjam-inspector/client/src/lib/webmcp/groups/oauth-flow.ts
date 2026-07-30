/**
 * OAuth-debugger tools: open the Configure-Server modal (prefilled), advance
 * the flow one protocol step, and reset the flow.
 *
 * Mount-scoped: `OAuthFlowTab` owns the state machine and the modal, so the
 * tools exist exactly while `/oauth-flow` is mounted. Three deliberate
 * postures:
 *
 * - **Prefill vs. commit.** `ui_open_oauth_server_config` only opens the
 *   Configure modal for the human to review and save (the
 *   `ui_open_server_form` precedent). Its payload can never carry credentials:
 *   there are no clientId/clientSecret fields, by design.
 * - **One step per advance, human consent stays human.**
 *   `ui_advance_oauth_flow` mirrors the Continue button exactly — a single
 *   state-machine step per call. At the authorization step it opens the
 *   sign-in popup to the third party's authorization server and reports that
 *   honestly; the agent cannot complete consent, only the user can. It is
 *   `destructiveHint: true` because a single step can POST a PERSISTENT
 *   dynamic-client registration to a third-party AS (and every step drives
 *   real third-party HTTP → `openWorldHint: true`), so the confirmation pill
 *   gates each advance.
 * - **Reset is cheap.** `ui_reset_oauth_flow` clears local, re-runnable debug
 *   state; the UI's own Reset button has no confirmation dialog either (unlike
 *   clearing a chat, no unrecoverable user content is lost), so it is not
 *   destructive.
 */

import type { UiToolDefinition } from "../ui-tools-registry";
import {
  commandResponseToActionResult,
  dispatchInspectorCommand,
} from "../ui-actions";
import { asOptionalString, errorResult, fromActionResult } from "./shared";

const REGISTRATION_MODES = ["preregistered", "dcr", "cimd"] as const;

export function buildOAuthFlowUiTools(): UiToolDefinition[] {
  return [
    {
      name: "ui_open_oauth_server_config",
      description:
        "Open the OAuth debugger's Configure-Server modal for the user to review and save. Optionally prefills the server name, MCP server URL, and registration mode. Credentials (client ID/secret) are always typed by the human — they cannot be passed here. Omit serverName to edit the currently selected server; pass a new name to create a new test target. Never commits anything itself.",
      inputSchema: {
        type: "object",
        properties: {
          serverName: {
            type: "string",
            description:
              "Server to configure, as the server tabs show it. Omitted → the selected server (or a blank form when none is selected). A name matching a different existing server is rejected.",
          },
          serverUrl: {
            type: "string",
            description: "MCP base URL to prefill (e.g. https://example.com/mcp).",
          },
          registrationMode: {
            type: "string",
            enum: [...REGISTRATION_MODES],
            description:
              "Client registration mode to prefill: 'preregistered' (human enters a client ID), 'dcr' (Dynamic Client Registration), or 'cimd' (URL-based client metadata; 2025-11-25 only).",
          },
        },
        additionalProperties: false,
      },
      readOnly: false,
      // Opens a form for the human; re-invoking with the same seed converges
      // on the same open modal. Nothing external, no route change.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      execute: async (args) => {
        const serverName = asOptionalString(args.serverName);
        if (args.serverName !== undefined && serverName === undefined) {
          return errorResult(
            "'serverName' must be a non-empty string when provided.",
          );
        }
        const serverUrl = asOptionalString(args.serverUrl);
        if (args.serverUrl !== undefined && serverUrl === undefined) {
          return errorResult(
            "'serverUrl' must be a non-empty string when provided.",
          );
        }
        const registrationMode = asOptionalString(args.registrationMode);
        if (args.registrationMode !== undefined) {
          if (
            !registrationMode ||
            !(REGISTRATION_MODES as readonly string[]).includes(
              registrationMode,
            )
          ) {
            return errorResult(
              `'registrationMode' must be one of: ${REGISTRATION_MODES.join(", ")}.`,
            );
          }
        }
        const response = await dispatchInspectorCommand({
          type: "openOauthServerConfig",
          payload: {
            ...(serverName ? { serverName } : {}),
            ...(serverUrl ? { serverUrl } : {}),
            ...(registrationMode
              ? {
                  registrationMode:
                    registrationMode as (typeof REGISTRATION_MODES)[number],
                }
              : {}),
          },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: "ui_advance_oauth_flow",
      description:
        "Advance the OAuth debugger exactly ONE protocol step — the same as clicking Continue. Steps make REAL requests to the target and its authorization server; the registration step can create a PERSISTENT client registration there. At the authorization step this opens a sign-in popup a HUMAN must complete (if none appeared, ask the user to check their popup blocker) — observe with ui_snapshot_app instead of re-calling. Errors if unconfigured, mid-step, or already complete.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      readOnly: false,
      // One step can POST a persistent DCR registration to a third-party AS →
      // destructive (pill gates every advance) + open-world. Each call is a
      // distinct step, so NOT idempotent. The sign-in popup is a browser
      // window, not an SPA route → no mayNavigate.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      execute: async () => {
        const response = await dispatchInspectorCommand({
          type: "advanceOauthFlow",
          payload: {},
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: "ui_reset_oauth_flow",
      description:
        "Reset the OAuth debugger's flow back to the start for the configured target. Clears the local step-by-step state (tokens, codes, logged requests) so the flow can be run again. Nothing is sent to any server.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      readOnly: false,
      // Local, re-runnable debug state; double-reset converges. The UI Reset
      // button has no confirmation dialog either.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      execute: async () => {
        const response = await dispatchInspectorCommand({
          type: "resetOauthFlow",
          payload: {},
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
  ];
}
