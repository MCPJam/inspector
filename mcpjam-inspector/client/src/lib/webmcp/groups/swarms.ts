/**
 * Swarms-screen tools: create a persona, open the new-journey form, and
 * launch a journey run.
 *
 * Mount-scoped like the evals/registry groups: `SwarmsTab` owns the command
 * handlers and the personas/journeys they resolve against, so the tools exist
 * exactly while `/swarms` is mounted. Two deliberate postures:
 *
 * - **Prefill vs. commit.** A persona is low-entropy (a name + role + optional
 *   notes) so `ui_create_persona` commits directly and the new persona shows
 *   up in the sidebar. A journey targets HOSTS and sets fan-out/turn config,
 *   so `ui_open_journey_form` only opens the form for the human — the
 *   `ui_open_server_form` / `ui_open_eval_suite_form` precedent. The only
 *   prefill it may carry is the goal text.
 * - **Billing.** `ui_launch_swarm_run` fans out N sessions and SPENDS the
 *   org's quota through the SAME `launchJourneyRun` REST path the Run button
 *   uses (with the same per-launch idempotency key). It is `destructiveHint:
 *   true` (confirmation pill) and `openWorldHint: true` (real model + MCP
 *   traffic). A 402/quota rejection comes back as an `execution_failed`
 *   command error naming the limit, never a bypass.
 *
 * Out of v1 (see the module comment in SwarmsTab.tsx): promote-to-eval (the
 * promotable session is lazily paginated inside a per-run view with no
 * top-level "selected session") and swarm host CRUD (admin role-gated). The
 * snapshot still surfaces host targets by name.
 */

import type { UiToolDefinition } from "../ui-tools-registry";
import {
  commandResponseToActionResult,
  dispatchInspectorCommand,
} from "../ui-actions";
import { asOptionalString, errorResult, fromActionResult } from "./shared";

const PERSONA_PROPERTY = {
  type: "string",
  description:
    "Persona as the Personas list shows it: its name (e.g. 'Impatient buyer') or its id.",
} as const;

const JOURNEY_PROPERTY = {
  type: "string",
  description:
    "Journey as its card shows it: the goal text (e.g. 'Book a flight to Tokyo') or the journey id. Must belong to the currently selected persona.",
} as const;

export function buildSwarmsUiTools(): UiToolDefinition[] {
  return [
    {
      name: "ui_create_persona",
      description:
        "Create a persona on the Swarms screen — a simulated user a journey runs as. Takes a short name and a role (e.g. 'QA tester', 'first-time customer'), plus optional free-text notes describing personality. Low-entropy, so this creates the persona directly and selects it. Journeys and runs for the persona are added afterward.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Short display name for the persona.",
          },
          role: {
            type: "string",
            description: "The persona's role (e.g. 'QA tester').",
          },
          notes: {
            type: "string",
            description: "Optional personality / behavior notes.",
          },
        },
        required: ["name", "role"],
        additionalProperties: false,
      },
      readOnly: false,
      // Creates a new persona each time (not idempotent), stays inside MCPJam.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      execute: async (args) => {
        const name = asOptionalString(args.name);
        const role = asOptionalString(args.role);
        if (!name) {
          return errorResult("Missing required 'name' string.");
        }
        if (!role) {
          return errorResult("Missing required 'role' string.");
        }
        const notes = asOptionalString(args.notes);
        if (args.notes !== undefined && typeof args.notes !== "string") {
          return errorResult("'notes' must be a string when provided.");
        }
        const response = await dispatchInspectorCommand({
          type: "createPersona",
          payload: { name, role, ...(notes ? { notes } : {}) },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: "ui_open_journey_form",
      description:
        "Open the new-journey form on the Swarms screen for the user to fill in and submit. A journey picks which HOSTS it runs against and how many sessions per host — high-entropy choices, so this only prepares the form; it never creates the journey. Optionally selects a persona and prefills the goal text. To START a journey that already exists, use ui_launch_swarm_run instead.",
      inputSchema: {
        type: "object",
        properties: {
          persona: PERSONA_PROPERTY,
          goal: {
            type: "string",
            description:
              "Optional goal text to prefill (what the persona is trying to accomplish).",
          },
        },
        additionalProperties: false,
      },
      readOnly: false,
      // Prepares a form for the user; nothing is created and no run is spent.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      execute: async (args) => {
        const persona = asOptionalString(args.persona);
        if (args.persona !== undefined && persona === undefined) {
          return errorResult(
            "'persona' must be a non-empty string when provided.",
          );
        }
        const goal = asOptionalString(args.goal);
        if (args.goal !== undefined && goal === undefined) {
          return errorResult("'goal' must be a non-empty string when provided.");
        }
        const response = await dispatchInspectorCommand({
          type: "openJourneyForm",
          payload: {
            ...(persona ? { persona } : {}),
            ...(goal ? { goal } : {}),
          },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: "ui_launch_swarm_run",
      description:
        "Launch a run of an existing journey — fans out one simulated session per (host × sessions-per-host) that make REAL model and MCP tool calls and SPEND the organization's quota (same gate as the Run journey button; a quota/billing rejection is reported as an error and the run is refused). The journey must belong to the currently selected persona. The run continues in the background; observe progress with ui_snapshot_app.",
      inputSchema: {
        type: "object",
        properties: { journey: JOURNEY_PROPERTY },
        required: ["journey"],
        additionalProperties: false,
      },
      readOnly: false,
      // Spends money and drives real third-party MCP traffic → destructive +
      // open-world. A retry is a new launch intent (the launch key dedupes a
      // network retry, not a deliberate re-invocation), so NOT idempotent.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      execute: async (args) => {
        const journey = asOptionalString(args.journey);
        if (!journey) {
          return errorResult("Missing required 'journey' string.");
        }
        const response = await dispatchInspectorCommand({
          type: "launchSwarmRun",
          payload: { journey },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
  ];
}
