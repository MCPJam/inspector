/**
 * Running a round from the change form: the best so far's mock gets the change
 * as a new version, and that version is submitted. Every step is an operation an
 * agent has too (`get_mock_server`, `update_mock_server`, `submit_climb_round`).
 */
import type { ChangeEntry } from "@mcpjam/sdk/climbs";
import { readMockDefinition, saveMockDefinition, submitRound } from "@/lib/apis/climbs-api";
import { mergePatch, patchFor } from "./change-model";
import type { Climb } from "./climb-types";

export async function runRound(input: { climb: Climb; entry: ChangeEntry; value: unknown }): Promise<{ roundNumber: number }> {
  const { climb, entry, value } = input;
  const best = climb.best;
  if (!best?.serverId) {
    throw new Error("This climb has no best server to change yet. Reload the page, then try again.");
  }
  const version = Number.parseInt(best.serverVersion ?? "", 10);
  const base = await readMockDefinition({
    projectId: climb.projectId,
    mockId: best.serverId,
    ...(Number.isInteger(version) ? { version } : {}),
  });
  const saved = await saveMockDefinition({
    projectId: climb.projectId,
    mockId: best.serverId,
    definition: mergePatch(base.definition, patchFor(entry, value)) as object,
    expectedVersion: base.headVersion,
  });
  const submitted = await submitRound({
    projectId: climb.projectId,
    climbId: climb.climbId,
    serverId: best.serverId,
    serverVersion: String(saved.version),
    // The same saved version submitted twice is one round, so a double click costs nothing.
    idempotencyKey: `app:${climb.climbId}:${best.serverId}:${saved.version}`,
  });
  return { roundNumber: submitted.roundNumber };
}
