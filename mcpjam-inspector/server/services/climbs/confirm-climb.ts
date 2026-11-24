/**
 * `confirm_climb`: two run groups on the cases no round ran, the mock with no
 * changes and the best server, launched back to back. The backend decides
 * whether the climb may be confirmed (stopped, a kept round, cases set aside,
 * not asked before) and registers the groups; it commits no credits, because a
 * confirmation sits outside the limits. This quotes it, launches it, and with a
 * wait hands back the interval once it settles.
 */
import type { PlatformClimb, PlatformClimbConfirmed } from "@mcpjam/sdk/platform";
import { ConvexError } from "convex/values";
import { climbFns, translateClimbWriteError } from "./backend.js";
import type { ClimbDeps } from "./deps.js";
import { estimateGroup } from "./estimate.js";
import { launchUnit, type RegisteredGroup } from "./launch-unit.js";
import { readConfirmation, summarizeStopped } from "./summary.js";

export type FinishPlan = {
  allowed: boolean;
  refusal?: { code: string; message: string; extra?: Record<string, unknown> };
  caseIds: string[];
  environmentIds: string[];
  confirmationCasesUsedBy: string[];
};

/** The plan of a confirmation or a verification, refused by the backend's own code when it may not run. */
export async function planFinish(deps: ClimbDeps, climbId: string, kind: "confirmation" | "verification"): Promise<FinishPlan> {
  const plan: FinishPlan = await deps.convex.query(climbFns.planFinish, { climbId, kind });
  if (!plan.allowed && plan.refusal) {
    throw translateClimbWriteError(new ConvexError({ code: plan.refusal.code, message: plan.refusal.message, ...plan.refusal.extra }));
  }
  return plan;
}

const POLL_MS = 2_000;

export async function confirmClimb(
  deps: ClimbDeps,
  projectId: string,
  climb: PlatformClimb,
  args: { dryRun: boolean; waitSeconds: number },
  clock: { now(): number; sleep(ms: number): Promise<void> } = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
): Promise<PlatformClimbConfirmed> {
  const plan = await planFinish(deps, climb.climbId, "confirmation");
  const estimate = await estimateGroup(deps.convex, { suiteId: climb.suiteId, environmentIds: plan.environmentIds, caseIds: plan.caseIds }, 2);
  const base = {
    climbId: climb.climbId,
    suiteId: climb.suiteId,
    estimate,
    confirmationCaseCount: plan.caseIds.length,
    environmentIds: plan.environmentIds,
    confirmationCasesUsedBy: plan.confirmationCasesUsedBy,
  };
  if (args.dryRun) return { ...base, dryRun: true, settled: false };

  const realListingHash = await deps.hashListing(projectId, climb.serverId);
  const begun: { unitKey: string; confirmationCasesUsedBy: string[]; groups: RegisteredGroup[] } = await deps.convex.mutation(
    climbFns.beginConfirmation,
    { climbId: climb.climbId, realListingHash, estimatedCreditsPerGroup: estimate.creditsPerGroup },
  );
  const groups = await launchUnit({
    client: deps.client,
    convex: deps.convex,
    projectId,
    suiteId: climb.suiteId,
    climbId: climb.climbId,
    unitKey: begun.unitKey,
    groups: begun.groups,
    serverName: climb.serverName,
    realListingHash,
  });
  const launched = { ...base, confirmationCasesUsedBy: begun.confirmationCasesUsedBy, dryRun: false, unitKey: begun.unitKey, groups };

  const deadline = clock.now() + args.waitSeconds * 1000;
  for (;;) {
    const confirmation = await readConfirmation(deps, climb.climbId);
    if (confirmation && confirmation.record.status !== "running") {
      const after: PlatformClimb = await deps.convex.query(climbFns.get, { climbId: climb.climbId });
      const summary = await summarizeStopped(deps, after);
      return { ...launched, settled: true, result: summary.confirmation, summary };
    }
    if (clock.now() + POLL_MS > deadline) return { ...launched, settled: false };
    await clock.sleep(POLL_MS);
  }
}
