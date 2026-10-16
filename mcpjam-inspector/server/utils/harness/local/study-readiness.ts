import { HOSTED_MODE, LOCAL_HARNESS_ENABLED } from "../../../config.js";
import { resolveLocalHarnessActor } from "./acting-user.js";
import type { LocalStudyReservation } from "./study-access.js";
import { validateModelSelection } from "@mcpjam/sdk";
import { fetchScenarioRuntimeConfig } from "../../scenario-runtime-config.js";
import { registerLocalInstance } from "../harness-model-broker.js";
import { getLocalMachineId } from "./grants.js";
import {
  readLocalInstanceIdentity,
  setRegisteredKeyId,
} from "./instance-key.js";
import {
  ensureLocalHarnessTarget,
  verifyLocalHarnessMember,
  localHarnessAccountEnabled,
} from "./readiness.js";
import { localHarnessIdOf } from "./run-resources.js";
import { requestLocalStudyReservation } from "./study-access.js";
import { prepareLocalStudyWorkspace } from "./study-workspace.js";

type StudySetupRequest = {
  bearer: string;
  scenarioId: string;
  accessVersion: number;
  chatSessionId: string;
};

async function resolveStudyPreview(
  args: StudySetupRequest,
  reservation: LocalStudyReservation,
  machineId: string,
  keyId: string,
) {
  const runtime = await fetchScenarioRuntimeConfig({
    ...args,
    ...(reservation.admission
      ? {
          localStudy: {
            localStudySessionId: reservation.reservationId,
            machineId,
            keyId,
            chatSessionId: args.chatSessionId,
          },
        }
      : {}),
  });
  if (!runtime.ok) throw new Error(runtime.error);
  const config = runtime.config;
  const projectId = config.executionScope?.projectId;
  const harnessId = localHarnessIdOf(config.harness);
  if (projectId && projectId !== reservation.projectId) throw new Error("The study reservation does not match this preview. Reopen the study and retry.");
  if (
    !config.executionScope ||
    (config.accessKind === "swarm_grant" && reservation.admission?.actorRole !== "participant") ||
    projectId !== reservation.projectId ||
    !projectId ||
    !harnessId ||
    !["project_member", "swarm_grant"].includes(config.accessKind ?? "") ||
    config.actorKind !== "signedIn" ||
    config.scenarioId !== args.scenarioId ||
    config.accessVersion !== args.accessVersion
  ) {
    throw new Error(
      "Local study preview requires current study access and a supported client.",
    );
  }
  const selection = validateModelSelection(config.modelSelection);
  if (
    reservation.admission
      ? !reservation.admission.modelSourceReady ||
        reservation.admission.harnessId !== harnessId
      : !selection.ok || !["hosted", "org"].includes(selection.selection.source)
  ) {
    throw new Error(
      "Choose and save a model source for this client before running locally.",
    );
  }
  if (!reservation.admission)
    await verifyLocalHarnessMember(
      args.bearer,
      projectId,
      undefined,
      harnessId,
    );
  return { config, projectId, harnessId };
}

/** Called only after an explicit local study confirmation. */
export async function setupLocalStudyPreview(args: StudySetupRequest) {
  if (HOSTED_MODE || !LOCAL_HARNESS_ENABLED)
    throw new Error("Local study execution is unavailable on this server.");
  const resolved = await resolveLocalHarnessActor({
    authorizationHeader: `Bearer ${args.bearer.replace(/^Bearer\s+/i, "")}`,
    contextCredential: null,
  });
  if (!resolved.ok) throw new Error(resolved.message);
  const actor = resolved.actor;
  const machineId = await getLocalMachineId();
  const identity = await readLocalInstanceIdentity();
  const registered = await registerLocalInstance({
    machineId,
    publicKey: identity.publicKey,
    bearer: args.bearer,
  });
  if (!registered.ok) throw new Error(registered.error);
  setRegisteredKeyId(registered.keyId);
  const reservation = await requestLocalStudyReservation(args.bearer, {
    action: "reserve",
    scenarioId: args.scenarioId,
    accessVersion: args.accessVersion,
    chatSessionId: args.chatSessionId,
    machineId,
    keyId: registered.keyId,
  });
  if (
    reservation.scenarioId !== args.scenarioId ||
    reservation.accessVersion !== args.accessVersion ||
    reservation.chatSessionId !== args.chatSessionId
  ) {
    throw new Error(
      "The study reservation does not match this preview. Reopen the study and retry.",
    );
  }
  const { config, projectId, harnessId } = await resolveStudyPreview(
    args,
    reservation,
    machineId,
    registered.keyId,
  );
  if (
    reservation.admission &&
    !(await localHarnessAccountEnabled(args.bearer, undefined, harnessId))
  )
    throw new Error("Local execution is not available for this account yet.");
  const study = {
    scenarioId: config.scenarioId,
    accessVersion: config.accessVersion,
    chatSessionId: args.chatSessionId,
    requireToolApproval: config.requireToolApproval,
  };
  const workspace = await prepareLocalStudyWorkspace({
    userId: actor.userId,
    projectId,
    study,
  });
  const ready = await ensureLocalHarnessTarget({
    bearer: args.bearer,
    projectId,
    harnessId,
    scope: "attended",
    studyAccepted: true,
    waitForInstall: false,
    workspaceGrantId: workspace.workspaceGrantId,
    requireToolApproval: config.requireToolApproval,
    study,
    localStudySessionId: reservation.reservationId,
  });
  return {
    ...ready,
    harnessId,
    reservation,
    target: { ...ready.target, localSessionId: workspace.localSessionId },
  };
}
