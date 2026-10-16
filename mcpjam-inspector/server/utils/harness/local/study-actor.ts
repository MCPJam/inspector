import { HOSTED_MODE, LOCAL_HARNESS_ENABLED } from "../../../config.js";
import {
  resolveLocalHarnessActor,
  type LocalHarnessActor,
} from "./acting-user.js";
import { getLocalMachineId } from "./grants.js";
import {
  getRegisteredKeyId,
  readLocalInstanceIdentity,
} from "./instance-key.js";
import { requestLocalStudyReservation } from "./study-access.js";
import type { LocalStudyGrantBinding } from "./study-grant-binding.js";
import type { SupportedLocalHarnessId } from "./targets.js";

/** A study reservation authorizes this actor only; it never grants project membership. */
export async function verifyLocalStudyActor(
  args: {
    bearer: string;
    projectId: string;
    harnessId: SupportedLocalHarnessId;
    study: LocalStudyGrantBinding;
    reservationId: string;
  },
  checks: {
    member: () => Promise<LocalHarnessActor>;
    rollout: () => Promise<boolean>;
  },
) {
  if (HOSTED_MODE || !LOCAL_HARNESS_ENABLED)
    throw new Error("Local study execution is unavailable on this server.");
  const resolved = await resolveLocalHarnessActor({
    authorizationHeader: `Bearer ${args.bearer.replace(/^Bearer\s+/i, "")}`,
    contextCredential: null,
  });
  if (!resolved.ok) throw new Error(resolved.message);
  const machineId = await getLocalMachineId();
  const identity = await readLocalInstanceIdentity();
  const keyId = identity.keyId ?? getRegisteredKeyId();
  if (!keyId)
    throw new Error(
      "Authorize this local installation before running the study.",
    );
  const reservation = await requestLocalStudyReservation(args.bearer, {
    action: "validate",
    reservationId: args.reservationId,
    machineId,
    keyId,
  });
  if (
    reservation.reservationId !== args.reservationId ||
    reservation.projectId !== args.projectId ||
    reservation.scenarioId !== args.study.scenarioId ||
    reservation.accessVersion !== args.study.accessVersion ||
    reservation.chatSessionId !== args.study.chatSessionId
  ) {
    throw new Error(
      "This local authorization belongs to another study conversation.",
    );
  }
  if (reservation.admission) {
    if (reservation.admission.harnessId !== args.harnessId)
      throw new Error("The study client changed. Authorize local setup again.");
    if (!reservation.admission.modelSourceReady)
      throw new Error(
        "Choose and save a model source for this client before running locally.",
      );
    if (!(await checks.rollout()))
      throw new Error("Local execution is not available for this account yet.");
  } else {
    const member = await checks.member();
    if (member.userId !== resolved.actor.userId)
      throw new Error("Local study identity changed. Sign in again.");
  }
  return { actor: resolved.actor, reservation, machineId, keyId };
}
