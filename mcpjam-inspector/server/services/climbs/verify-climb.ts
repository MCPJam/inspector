/**
 * `verify_climb`: does the gain the mock showed hold on the real server?
 *
 * After the coding agent applies the kept changes and the server runs them, this
 * checks the server's listing against each kept change (applied, missing or
 * different) and stops there unless asked to run anyway. Then it runs the
 * server through a mock with no changes beside the server through a mock that
 * puts the old values back, back to back, and the backend settles the pair with
 * the climb's rule and noise. Both arms go through a mock so the route is the
 * same on both sides and only the change differs. When a kept change cannot be
 * put back, only the server runs, and its result is set beside the recorded one
 * with its age.
 */
import type { ConvexHttpClient } from "convex/browser";
import { checkKeptChanges, maskKeptFields, verificationReport, type ListingCheck } from "@mcpjam/sdk/climbs";
import { diffMockDefinitions, hashRealToolListing, inverseOfChanges, type Unrestorable } from "@mcpjam/sdk/mocks";
import type { PlatformClimb, PlatformClimbVerified } from "@mcpjam/sdk/platform";
import { climbFns } from "./backend.js";
import { planFinish } from "./confirm-climb.js";
import type { ClimbDeps } from "./deps.js";
import { estimateGroup } from "./estimate.js";
import { launchUnit, type RegisteredGroup } from "./launch-unit.js";
import { loadOldServer } from "./old-server.js";
import { definitionOf } from "./round-changes.js";

export type VerifyArgs = {
  dryRun: boolean;
  runAnyway: boolean;
  waitSeconds: number;
  /** A saved server that runs the new code, in place of the climbed one. */
  targetServerId?: string;
  serverVersion?: string;
  commit?: { sha?: string; branch?: string; repositoryUrl?: string; dirty?: boolean };
};

type MockMade = { mockId: string; version: number };

const POLL_MS = 2_000;

export async function verifyClimb(
  deps: ClimbDeps,
  projectId: string,
  climb: PlatformClimb,
  args: VerifyArgs,
  clock: { now(): number; sleep(ms: number): Promise<void> } = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
): Promise<PlatformClimbVerified> {
  const { convex } = deps;
  const plan = await planFinish(deps, climb.climbId, "verification");
  const targetId = args.targetServerId ?? climb.serverId;

  const best = climb.best ? await definitionOf(convex, climb.best.serverId, climb.best.serverVersion) : undefined;
  const kept = diffMockDefinitions({}, best ?? {});
  const old = await loadOldServer(deps, projectId, climb.serverId, climb.createdAt);
  const listing = await deps.readServer(projectId, targetId);
  const listingCheck = checkKeptChanges(kept, listing, old && { instructions: old.instructions, tools: old.tools });
  const inverse = old ? inverseOfChanges(kept, old) : undefined;
  const restorable = inverse !== undefined && inverse.unrestorable.length === 0 && Object.keys(inverse.definition).length > 0;
  const unrestorable: Unrestorable[] = inverse?.unrestorable ?? [{ path: "(all)", why: "No stored capture of the server from before the climb, so its old values are not known." }];

  const estimate = await estimateGroup(convex, { suiteId: climb.suiteId, environmentIds: plan.environmentIds, caseIds: plan.caseIds }, restorable ? 2 : 1);
  const mode = restorable ? "paired" : "server_only";
  const base = { climbId: climb.climbId, suiteId: climb.suiteId, listingCheck, estimate, mode, unrestorable, settled: false } as const;

  const mismatched = listingCheck.missing + listingCheck.different > 0;
  if (args.dryRun) return { ...base, dryRun: true, ran: false, ...(mismatched ? { blockedBecause: blockedMessage(listingCheck) } : {}) };
  if (mismatched && !args.runAnyway) return { ...base, dryRun: false, ran: false, blockedBecause: blockedMessage(listingCheck) };

  const tag = `climb ${climb.climbId.slice(-6)} verification ${climb.verifications.length + 1}`;
  const serverHash = hashRealToolListing(maskKeptFields(listing.tools, kept));
  const serverMock = await makeMock(convex, projectId, targetId, `${climb.serverName} (${tag} server)`, {});
  const restoreMock = restorable && inverse ? await makeMock(convex, projectId, targetId, `${climb.serverName} (${tag} restore)`, inverse.definition) : undefined;
  // Read again after the mocks exist: a deploy in between makes the two hashes differ, and the round is not decided.
  const restoreHash = hashRealToolListing(maskKeptFields((await deps.readServer(projectId, targetId)).tools, kept));

  const begun: { unitKey: string; verificationIndex: number; groups: RegisteredGroup[] } = await convex.mutation(climbFns.beginVerification, {
    climbId: climb.climbId,
    serverMockId: serverMock.mockId,
    serverMockVersion: String(serverMock.version),
    ...(restoreMock ? { restoreMockId: restoreMock.mockId, restoreMockVersion: String(restoreMock.version), restoreListingHash: restoreHash } : {}),
    serverListingHash: serverHash,
    ...(args.targetServerId ? { targetServerId: args.targetServerId } : {}),
    ...(args.serverVersion ? { serverVersion: args.serverVersion } : {}),
    ...(args.commit?.sha ? { commitSha: args.commit.sha } : {}),
    ...(args.commit?.branch ? { branch: args.commit.branch } : {}),
    ...(args.commit?.repositoryUrl ? { repositoryUrl: args.commit.repositoryUrl } : {}),
    ...(args.commit?.dirty !== undefined ? { dirty: args.commit.dirty } : {}),
    listingCheck: summarizeCheck(listingCheck),
    estimatedCreditsPerGroup: estimate.creditsPerGroup,
  });
  const groups = await launchUnit({
    client: deps.client,
    convex,
    projectId,
    suiteId: climb.suiteId,
    climbId: climb.climbId,
    unitKey: begun.unitKey,
    groups: begun.groups,
    serverName: climb.serverName,
    realListingHash: serverHash,
  });
  const started = { ...base, dryRun: false, ran: true, unitKey: begun.unitKey, verificationIndex: begun.verificationIndex, groups } as const;

  const deadline = clock.now() + args.waitSeconds * 1000;
  for (;;) {
    const current: PlatformClimb = await convex.query(climbFns.get, { climbId: climb.climbId });
    const record = current.verifications.find((entry) => entry.index === begun.verificationIndex);
    if (record && record.status !== "running") return { ...started, settled: true, report: verificationReport(current, record) };
    if (clock.now() + POLL_MS > deadline) return started;
    await clock.sleep(POLL_MS);
  }
}

async function makeMock(convex: ConvexHttpClient, projectId: string, baseServerId: string, name: string, definition: object): Promise<MockMade> {
  return convex.mutation(climbFns.createMock, { projectId, baseServerId, name, definitionJson: JSON.stringify(definition) });
}

/** What is stored on the climb about the check: the verdict per kept change, not the values. */
function summarizeCheck(check: ListingCheck) {
  return {
    applied: check.applied,
    missing: check.missing,
    different: check.different,
    changes: check.changes.map(({ path, status }) => ({ path, status })),
  };
}

function blockedMessage(check: ListingCheck): string {
  const missing = check.changes.filter((entry) => entry.status === "missing").map((entry) => entry.path);
  const different = check.changes.filter((entry) => entry.status === "different").map((entry) => entry.path);
  return (
    [
      missing.length > 0 ? `Not applied on the server yet: ${missing.join(", ")}.` : undefined,
      different.length > 0 ? `Applied differently from the kept value: ${different.join(", ")}.` : undefined,
    ]
      .filter(Boolean)
      .join(" ") + " No run was started. Apply the change and verify again, or pass runAnyway to run the pair as the server is."
  );
}
