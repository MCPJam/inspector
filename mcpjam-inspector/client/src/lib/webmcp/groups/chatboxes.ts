/**
 * User Testing tools: publish an environment as a scenario, and delete one.
 *
 * Mount-scoped like the evals/registry/hosts groups: `UserTestingTab` owns the
 * command handlers and the environments/scenarios they resolve against, so the
 * tools exist exactly while `/user-testing` is mounted. Deliberate postures:
 *
 * - **Publish is ENVIRONMENT-anchored.** A scenario is a published environment
 *   — its client, servers and skills — behind a share link, so
 *   `ui_publish_chatbox` targets an environment by name/id. It is idempotent:
 *   an environment that is already published is opened rather than re-published,
 *   and its access mode is left alone. Both `access` and `name` apply at
 *   creation only, in the same mutation as the publish.
 * - **Delete is destructive and SCENARIO-anchored.** `ui_delete_chatbox`
 *   removes a scenario, its share link and its tester-session history — never
 *   the environment behind it.
 *
 * Both address things by the name the human sees on screen (Chrome's "semantic
 * values, not internal identifiers"), with ids accepted for disambiguation.
 * Resolution is EXACT and refuses ambiguity rather than guessing, because both
 * commands act on the wrong thing silently if they guess wrong.
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

const ACCESS_VALUES = ["invited_only", "link_guests", "project"] as const;
type AccessValue = (typeof ACCESS_VALUES)[number];

export function buildChatboxesUiTools(): UiToolDefinition[] {
  return [
    {
      name: "ui_publish_chatbox",
      description:
        "Publish one of this project's environments as a User Testing scenario — a share link real testers can open, whose sessions come back as insights — and open that scenario. Use it when someone wants to hand their setup to real people and read what happened. Idempotent: an environment that is already published is opened as-is, keeping the access it already has. Copying the share link is a human action — check ui_snapshot_app for whether a link exists.",
      inputSchema: {
        type: "object",
        properties: {
          environment: {
            type: "string",
            description:
              "Environment to publish, as the Environments screen names it (e.g. 'Checkout flow'), or its environment id.",
          },
          access: {
            type: "string",
            enum: [...ACCESS_VALUES],
            description:
              "Who may open the link: 'invited_only' (people invited by email), 'link_guests' (anyone with the link, including signed-out visitors, funded by this organization), or 'project' (signed-in project members). Applied when the scenario is created; defaults to 'invited_only'.",
          },
          name: {
            type: "string",
            description:
              "What to call the scenario. Defaults to the environment's own name. Applied when the scenario is created.",
          },
        },
        required: ["environment"],
        additionalProperties: false,
      },
      readOnly: false,
      // Creates a share surface rather than wiping one, and re-publishing an
      // already-published environment converges on the same scenario →
      // idempotent, not destructive. Stays inside MCPJam.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      execute: async (args) => {
        // Validate strictly here, loosely in the schema (Chrome): the errors
        // are what let the model correct itself on the next turn.
        const environment = asOptionalString(args.environment);
        if (!environment) {
          return errorResult(
            "Missing required 'environment' string (an environment name or id — list them with ui_snapshot_app).",
          );
        }
        const access = asOptionalString(args.access);
        if (access && !ACCESS_VALUES.includes(access as AccessValue)) {
          return errorResult(
            `Unknown access "${access}". Use one of: ${ACCESS_VALUES.join(
              ", ",
            )}.`,
          );
        }
        const name = asOptionalString(args.name);
        const response = await dispatchInspectorCommand({
          type: "publishChatbox",
          payload: {
            environment,
            ...(access ? { access: access as AccessValue } : {}),
            ...(name ? { name } : {}),
          },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: "ui_delete_chatbox",
      description:
        "Permanently delete a User Testing scenario — its share link stops working and its saved tester-session history is cleared. Irreversible; be sure the user wants this exact scenario gone. Addressed by scenario name or id, exactly as the scenario list shows it. What happens to the setup behind it depends on the scenario: one created by the User Testing flow also retires its private setup and the client backing it, while one published from a saved environment leaves that environment untouched. The result says which happened — report that rather than assuming.",
      inputSchema: {
        type: "object",
        properties: {
          scenario: {
            type: "string",
            description:
              "Scenario to delete, as the User Testing list names it, or its scenario id.",
          },
        },
        required: ["scenario"],
        additionalProperties: false,
      },
      readOnly: false,
      // Irreversible delete → approval pill. Deleting an already-deleted
      // scenario fails cleanly rather than deleting something else.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      execute: async (args) => {
        const scenario = asOptionalString(args.scenario);
        if (!scenario) {
          return errorResult(
            "Missing required 'scenario' string (a scenario name or id — list them with ui_snapshot_app).",
          );
        }
        const response = await dispatchInspectorCommand({
          type: "deleteChatbox",
          payload: { scenario },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
  ];
}
