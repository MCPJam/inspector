import { z } from "zod";
import { HOSTED_MODE } from "../../../config.js";
import { fetchScenarioRuntimeConfig } from "../../scenario-runtime-config.js";
import { resolveLocalHarnessActor } from "./acting-user.js";
import { localHarnessAccountEnabled } from "./readiness.js";
import { revokeLocalStudyReservation } from "./study-access.js";
import { cleanupLocalStudyWorkspace } from "./study-workspace.js";
const admissionSchema = z.object({
  harnessId: z.enum(["claude-code", "codex"]),
  modelSourceReady: z.boolean(),
});

export async function localStudyAvailability(args: {
  bearer: string;
  scenarioId: string;
  accessVersion: number;
}) {
  const runtime = await fetchScenarioRuntimeConfig(args);
  if (!runtime.ok) throw new Error(runtime.error);
  const admission = admissionSchema.safeParse(
    runtime.config.localStudyAdmission,
  );
  if (
    !admission.success ||
    !(await localHarnessAccountEnabled(
      args.bearer,
      undefined,
      admission.data.harnessId,
    ))
  )
    return null;
  return admission.data;
}
export async function revokeLocalStudy(args: {
  bearer: string;
  reservationId: string;
}) {
  if (HOSTED_MODE)
    throw new Error("Local study control is unavailable on this server.");
  const actor = await resolveLocalHarnessActor({
    authorizationHeader: `Bearer ${args.bearer.replace(/^Bearer\s+/i, "")}`,
    contextCredential: null,
  });
  if (!actor.ok) throw new Error(actor.message);
  const reservation = await revokeLocalStudyReservation(
    args.bearer,
    args.reservationId,
  );
  const cleanupComplete = await cleanupLocalStudyWorkspace({
    userId: actor.actor.userId,
    projectId: reservation.projectId,
    study: {
      scenarioId: reservation.scenarioId,
      accessVersion: reservation.accessVersion,
      chatSessionId: reservation.chatSessionId,
    },
  });
  return { revoked: true as const, cleanupComplete };
}
