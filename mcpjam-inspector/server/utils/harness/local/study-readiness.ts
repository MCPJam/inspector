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

async function resolveStudyPreview(args: StudySetupRequest) {
  const runtime = await fetchScenarioRuntimeConfig(args);
  if (!runtime.ok) throw new Error(runtime.error);
  const config = runtime.config;
  const projectId = config.executionScope?.projectId;
  const harnessId = localHarnessIdOf(config.harness);
  if (
    config.executionScope?.kind !== "project" ||
    !projectId ||
    !harnessId ||
    config.accessKind !== "project_member" ||
    config.actorKind !== "signedIn" ||
    config.scenarioId !== args.scenarioId ||
    config.accessVersion !== args.accessVersion
  ) {
    throw new Error(
      "Local study preview requires a current project member and a supported client.",
    );
  }
  const selection = validateModelSelection(config.modelSelection);
  if (
    !selection.ok ||
    !["hosted", "org"].includes(selection.selection.source)
  ) {
    throw new Error(
      "Choose and save a model source for this client before running locally.",
    );
  }
  const actor = await verifyLocalHarnessMember(
    args.bearer,
    projectId,
    undefined,
    harnessId,
  );
  return { config, projectId, harnessId, actor };
}

/** Called only after an explicit local study confirmation. */
export async function setupLocalStudyPreview(args: StudySetupRequest) {
  const { config, projectId, harnessId, actor } = await resolveStudyPreview(
    args,
  );
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
    scenarioId: config.scenarioId,
    accessVersion: config.accessVersion,
    chatSessionId: args.chatSessionId,
    machineId,
    keyId: registered.keyId,
  });
  if (
    reservation.projectId !== projectId ||
    reservation.scenarioId !== config.scenarioId ||
    reservation.accessVersion !== config.accessVersion ||
    reservation.chatSessionId !== args.chatSessionId
  ) {
    throw new Error(
      "The study reservation does not match this preview. Reopen the study and retry.",
    );
  }
  const study = {
    scenarioId: config.scenarioId,
    accessVersion: config.accessVersion,
    chatSessionId: args.chatSessionId,
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
