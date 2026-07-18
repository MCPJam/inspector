/**
 * Computer-screen tools: start, hibernate, reset, and delete the project's
 * cloud computer.
 *
 * Mount-scoped like the registry/evals/swarms/hosts groups: `ComputerView` owns
 * the command handlers and the live status they resolve against, so the tools
 * exist exactly while `/computer` is mounted. Deliberate postures:
 *
 * - **One computer, no target.** There is exactly one computer per project per
 *   user, so none of these tools takes a target — the project is resolved from
 *   the surface, never from the agent, and each tool has an empty input schema.
 * - **Availability + billing gates.** The handlers call the SAME action hooks
 *   the buttons use behind the SAME gates: unavailable (no data plane / no
 *   signed-in project) ⇒ `unsupported_in_mode`; the daily start cap is enforced
 *   server-side on reserve and comes back from `ui_start_computer` as an
 *   `execution_failed` naming the cap, never a bypass.
 * - **Start is billed, not destructive.** `ui_start_computer` spins/wakes real
 *   infra (`openWorldHint: true`) and counts against the daily cap, but it
 *   CREATES rather than wipes, so it is not destructive — the cap gate, not an
 *   approval pill, governs it. `ui_reset_computer` and `ui_delete_computer`
 *   wipe files and are `destructiveHint: true`. Hibernate is a reversible
 *   pause.
 * - **Terminal is human-only.** Opening the interactive terminal mints a
 *   short-lived token and drops a human into a live shell — not an agent
 *   action — so there is intentionally no `ui_open_terminal`. The snapshot
 *   reports whether a terminal is open; no token ever crosses the transcript.
 */

import type { UiToolDefinition } from "../ui-tools-registry";
import {
  commandResponseToActionResult,
  dispatchInspectorCommand,
} from "../ui-actions";
import { fromActionResult } from "./shared";

const EMPTY_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

export function buildComputerUiTools(): UiToolDefinition[] {
  return [
    {
      name: "ui_start_computer",
      description:
        "Start the project's cloud computer — provision it on first use, or wake it if it's asleep. This spins up REAL infrastructure and counts against the daily start cap (same gate as the Open-terminal button; a cap rejection is reported as an error and the start is refused). It does NOT open the interactive terminal (that's a human action). The computer comes up in the background; watch ui_snapshot_app for it to reach 'ready'.",
      inputSchema: EMPTY_SCHEMA,
      readOnly: false,
      // Billed + daily-cap-gated: spins/wakes real infra → open-world. It
      // CREATES rather than wipes, so not destructive (the cap gate governs
      // it). A retry can consume another start against the cap → not idempotent.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      execute: async () => {
        const response = await dispatchInspectorCommand({
          type: "startComputer",
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: "ui_hibernate_computer",
      description:
        "Hibernate the project's computer now — put it to sleep immediately. Non-destructive: files and state are preserved and it wakes on next use. Hibernating an already-asleep computer reports that there was nothing to pause.",
      inputSchema: EMPTY_SCHEMA,
      readOnly: false,
      // Reversible pause, stays inside MCPJam; hibernating an asleep computer
      // converges rather than doing anything new.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      execute: async () => {
        const response = await dispatchInspectorCommand({
          type: "hibernateComputer",
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: "ui_reset_computer",
      description:
        "Reset the project's computer to its image — WIPES all files and mutable state on it. Irreversible; be sure the user wants a clean box. Reports if there was nothing to reset.",
      inputSchema: EMPTY_SCHEMA,
      readOnly: false,
      // Wipes files → destructive (approval pill). Resetting to the same image
      // converges, so idempotent.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      execute: async () => {
        const response = await dispatchInspectorCommand({
          type: "resetComputer",
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: "ui_delete_computer",
      description:
        "Delete the project's computer entirely, removing all files on it. Irreversible — be sure the user wants this. A new computer can be started later with ui_start_computer.",
      inputSchema: EMPTY_SCHEMA,
      readOnly: false,
      // Irreversible teardown → destructive. Deleting an already-gone computer
      // fails cleanly / reports nothing to delete.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      execute: async () => {
        const response = await dispatchInspectorCommand({
          type: "deleteComputer",
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
  ];
}
