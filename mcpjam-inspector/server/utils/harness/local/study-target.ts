import { verifyLocalHarnessGrant } from "./grants.js";
import {
  verifyLocalHarnessMember,
  localHarnessAccountEnabled,
} from "./readiness.js";
import { verifyLocalStudyActor } from "./study-actor.js";
import {
  parseHarnessExecutionTarget,
  type RawHarnessTargetInput,
} from "./request-target.js";
import type { LocalStudyGrantBinding } from "./study-grant-binding.js";
import { prepareLocalStudyWorkspace } from "./study-workspace.js";
import type { SupportedLocalHarnessId } from "./targets.js";

interface StudyTargetRequest {
  bearer: string;
  projectId: string;
  harnessId: SupportedLocalHarnessId;
  study: LocalStudyGrantBinding;
  rawTarget: RawHarnessTargetInput;
  grantToken: string | undefined;
}

/** Resolves only an explicit study request; a missing grant never falls back. */
export async function resolveLocalStudyTarget(args: StudyTargetRequest) {
  const reservationId = args.rawTarget.localStudySessionId;
  if (typeof reservationId !== "string" || !reservationId)
    throw new Error(
      "Authorize this study conversation before running locally.",
    );
  const { actor, machineId, keyId } = await verifyLocalStudyActor(
    { ...args, reservationId },
    {
      member: () =>
        verifyLocalHarnessMember(
          args.bearer,
          args.projectId,
          undefined,
          args.harnessId,
        ),
      rollout: () =>
        localHarnessAccountEnabled(args.bearer, undefined, args.harnessId),
    },
  );
  const parsed = parseHarnessExecutionTarget({
    body: { harnessTarget: args.rawTarget },
    grantTokenHeader: args.grantToken,
    serverEnabled: true,
    actorEligible: true,
    actingUserId: actor.userId,
  });
  if (parsed.kind !== "local-native")
    throw new Error(
      parsed.kind === "refused"
        ? parsed.reason
        : "A local study target is required.",
    );
  const target = parsed.target;
  if (target.machineId !== machineId)
    throw new Error(
      "This study authorization belongs to another installation.",
    );
  const grant = await verifyLocalHarnessGrant(target.grantToken, {
    scope: "attended",
    study: args.study,
    userId: actor.userId,
    machineId,
    projectId: args.projectId,
    workspaceGrantId: target.workspaceGrantId,
    harnessId: args.harnessId,
    targetKind: "local-native",
    runtimeId: target.runtimeId,
    permissionProfile: target.permissionProfile,
    policyVersion: target.policyVersion,
  });
  if (!grant.ok) throw new Error(grant.message);
  const workspace = await prepareLocalStudyWorkspace({
    userId: actor.userId,
    projectId: args.projectId,
    study: args.study,
  });
  if (workspace.workspaceGrantId !== target.workspaceGrantId)
    throw new Error("Re-authorize this study after restarting Inspector.");
  return {
    ...target,
    study: args.study,
    localStudySessionId: reservationId,
    localStudyKeyId: keyId,
    localSessionId: workspace.localSessionId,
  };
}
