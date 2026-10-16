import { getLocalMachineId, verifyLocalHarnessGrant } from "./grants.js";
import {
  getRegisteredKeyId,
  readLocalInstanceIdentity,
} from "./instance-key.js";
import { verifyLocalHarnessMember } from "./readiness.js";
import {
  parseHarnessExecutionTarget,
  type RawHarnessTargetInput,
} from "./request-target.js";
import { requestLocalStudyReservation } from "./study-access.js";
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

async function verifyReservation(
  args: StudyTargetRequest,
  reservationId: string,
  machineId: string,
) {
  const identity = await readLocalInstanceIdentity();
  const keyId = identity.keyId ?? getRegisteredKeyId();
  if (!keyId)
    throw new Error(
      "Set up this local client before authorizing a study preview.",
    );
  const reservation = await requestLocalStudyReservation(args.bearer, {
    action: "validate",
    reservationId,
    machineId,
    keyId,
  });
  if (
    reservation.reservationId !== reservationId ||
    reservation.projectId !== args.projectId ||
    reservation.scenarioId !== args.study.scenarioId ||
    reservation.accessVersion !== args.study.accessVersion ||
    reservation.chatSessionId !== args.study.chatSessionId
  ) {
    throw new Error(
      "This local authorization belongs to another study conversation.",
    );
  }
  return keyId;
}

/** Resolves only an explicit study request; a missing grant never falls back. */
export async function resolveLocalStudyTarget(args: StudyTargetRequest) {
  const actor = await verifyLocalHarnessMember(
    args.bearer,
    args.projectId,
    undefined,
    args.harnessId,
  );
  const reservationId = args.rawTarget.localStudySessionId;
  if (typeof reservationId !== "string" || !reservationId)
    throw new Error(
      "Authorize this study conversation before running locally.",
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
  const machineId = await getLocalMachineId();
  if (target.machineId !== machineId)
    throw new Error(
      "This study authorization belongs to another installation.",
    );
  const keyId = await verifyReservation(args, reservationId, machineId);
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
