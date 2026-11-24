/**
 * What `get_climb` returns beyond what the backend settled: the suite check,
 * the things a climb can be for with the failed runs behind each, and the
 * ranked list of what a mock can change. Everything here is built by the
 * climb functions in the SDK from the climb, the real server and the baseline's
 * steering iterations; none of it recomputes the keep rule or the noise.
 */
import {
  climbForOptions,
  suiteCheck,
  summarizeConfirmation,
  verificationReport,
  whatCanChange,
  type ChangeEntry,
  type ClimbForOption,
  type ConfirmationSummary,
  type SuiteCheck,
  type VerificationReport,
} from "@mcpjam/sdk/climbs";
import type { PlatformClimb } from "@mcpjam/sdk/platform";
import { logger } from "../../utils/logger.js";
import { clientsOfClimb } from "./clients.js";
import type { ClimbDeps } from "./deps.js";
import { loadBaselineEvidence } from "./evidence.js";
import { loadRoundChanges } from "./round-changes.js";
import { readConfirmation } from "./summary.js";

export type ClimbRead = PlatformClimb & {
  suiteCheck: SuiteCheck;
  climbFor?: ClimbForOption[];
  whatCanChange?: ChangeEntry[];
  /** The confirmation's difference and interval once it has settled. */
  confirmationResult?: ConfirmationSummary;
  verificationReports?: VerificationReport[];
  /** What this read could not do, in words a caller can act on. */
  notes: string[];
};

export async function readClimbInFull(deps: ClimbDeps, climb: PlatformClimb): Promise<ClimbRead> {
  const check = suiteCheck(climb);
  const reports = climb.verifications.length > 0 ? { verificationReports: climb.verifications.map((entry) => verificationReport(climb, entry)) } : {};
  if (!climb.baseline) return { ...climb, ...reports, suiteCheck: check, notes: ["The baseline has not settled yet. Read the climb again when its state is ready."] };

  const notes: string[] = [];
  const { projectId } = climb;
  const confirmationResult =
    climb.confirmation?.status === "settled" ? summarizeConfirmation(climb, await readConfirmation(deps, climb.climbId)) : undefined;
  const server = await deps.readServer(projectId, climb.serverId).catch((error: unknown) => {
    // A server that is down must not hide what the backend settled.
    logger.warn("[climbs] the real server was not read for get_climb", {
      climbId: climb.climbId,
      error: error instanceof Error ? error.message : String(error),
    });
    notes.push("MCPJam could not read the real server just now, so what can change is not listed. Check that it is up, then read the climb again.");
    return undefined;
  });
  const listedTools = new Set(server?.tools.map((tool) => tool.name) ?? []);
  const { evidence, available } = await loadBaselineEvidence(deps, climb, { projectId, appOrigin: deps.appOrigin, listedTools });
  if (!available) notes.push("This backend does not return the baseline's runs yet, so no failed runs are shown.");

  const options = climbForOptions(climb, evidence, { toolCount: server?.tools.length });
  if (!server) return { ...climb, ...reports, suiteCheck: check, climbFor: options, ...(confirmationResult ? { confirmationResult } : {}), notes };
  const [clients, tried] = await Promise.all([clientsOfClimb(deps.convex, climb), loadRoundChanges(deps.convex, climb)]);
  const view = { serverInfo: server.serverInfo, instructions: server.instructions, tools: server.tools };
  return {
    ...climb,
    ...reports,
    suiteCheck: check,
    climbFor: options,
    whatCanChange: whatCanChange({ server: view, clients, evidence, tried }),
    ...(confirmationResult ? { confirmationResult } : {}),
    notes,
  };
}
