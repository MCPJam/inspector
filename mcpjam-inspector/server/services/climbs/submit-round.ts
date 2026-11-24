/**
 * `submit_climb_round`: one saved server, measured against the best so far.
 *
 * The backend decides whether the round may run and registers its run groups:
 * the candidate and, when the best so far's numbers are old or the suite
 * changed (amendment A2), the best measured again. Everything it refuses, it
 * refuses before a run (the round limit, the credit limit, a round already
 * running, an environment that lost the server, a suite with nothing to fix for
 * pass rate). This quotes the round, registers it, and launches it.
 */
import { ConvexError } from "convex/values";
import type { PlatformClimb, PlatformClimbRoundSubmitted, PlatformClimbSubmittedVia } from "@mcpjam/sdk/platform";
import { convexErrorData } from "../../routes/v1/convex-errors.js";
import { climbFns, translateClimbWriteError } from "./backend.js";
import type { ClimbDeps } from "./deps.js";
import { estimateGroup } from "./estimate.js";
import { launchUnit, type RegisteredGroup } from "./launch-unit.js";
import { refuseIfNoClientReads } from "./unread-change.js";

type RoundPlan = {
  allowed: boolean;
  refusal?: { code: string; message: string; extra?: Record<string, unknown> };
  candidateCaseIds: string[];
  remeasureBest: null | { caseIds: string[]; reasons: string[] };
};

type RoundRegistration = {
  roundNumber: number;
  unitKey: string;
  replayed?: boolean;
  remeasureBest: boolean;
  remeasureReasons?: string[];
  groups: RegisteredGroup[];
};

export type SubmitRoundArgs = {
  serverId: string;
  serverVersion?: string;
  idempotencyKey: string;
  submittedVia: PlatformClimbSubmittedVia;
};

export async function submitRound(
  deps: ClimbDeps,
  projectId: string,
  climb: PlatformClimb,
  args: SubmitRoundArgs,
): Promise<PlatformClimbRoundSubmitted> {
  const { convex } = deps;
  const { climbId } = climb;
  const plan: RoundPlan = await convex.query(climbFns.planRound, { climbId });
  if (!plan.allowed && plan.refusal) {
    // The same refusal a caller gets from the backend itself, so every surface reads one set of codes.
    throw translateClimbWriteError(
      new ConvexError({ code: plan.refusal.code, message: plan.refusal.message, ...plan.refusal.extra }),
    );
  }
  const serverVersion = args.serverVersion ?? (await headVersionOf(convex, args.serverId));
  // A change no client of the climb reads would measure nothing: refuse it before any run.
  await refuseIfNoClientReads(convex, climb, args.serverId, serverVersion);
  const realListingHash = await deps.hashListing(projectId, climb.serverId);
  const groups = plan.remeasureBest ? 2 : 1;
  const estimate = await estimateGroup(
    convex,
    { suiteId: climb.suiteId, environmentIds: climb.environmentIds, caseIds: plan.candidateCaseIds },
    groups,
  );
  const registration: RoundRegistration = await convex.mutation(climbFns.beginRound, {
    climbId,
    serverId: args.serverId,
    ...(serverVersion ? { serverVersion } : {}),
    realListingHash,
    idempotencyKey: args.idempotencyKey,
    estimatedCreditsPerGroup: estimate.creditsPerGroup,
    submittedVia: args.submittedVia,
  });
  // A repeat of a key that already launched has nothing left to start; a group that
  // was registered and never launched (the first call died between the two) still does.
  const toLaunch = registration.groups.filter((group) => group.status === "registered");
  const launched = await launchUnit({
    client: deps.client,
    convex,
    projectId,
    suiteId: climb.suiteId,
    climbId,
    unitKey: registration.unitKey,
    groups: toLaunch,
    serverName: climb.serverName,
    realListingHash,
  });
  return {
    climbId,
    suiteId: climb.suiteId,
    roundNumber: registration.roundNumber,
    unitKey: registration.unitKey,
    replayed: registration.replayed === true,
    estimate: { ...estimate, groups: registration.groups.length },
    remeasureBest: registration.remeasureBest,
    remeasureReasons: registration.remeasureReasons ?? [],
    groups: launched,
  };
}

/**
 * The mock version a round runs when the caller named none: its head right now,
 * so an edit to the mock while the round runs cannot change what was measured.
 * A server that is not a mock has no version.
 */
async function headVersionOf(convex: ClimbDeps["convex"], serverId: string): Promise<string | undefined> {
  try {
    const mock: { version: number } = await convex.query(climbFns.getMock, { mockId: serverId });
    return String(mock.version);
  } catch (error) {
    if (convexErrorData(error)?.code === "MOCK_NOT_FOUND") return undefined;
    throw error;
  }
}
