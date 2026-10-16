import { HOSTED_MODE, LOCAL_HARNESS_ENABLED } from "../../../config.js";
import { getLocalMachineId } from "./grants.js";
import {
  getRegisteredKeyId,
  readLocalInstanceIdentity,
} from "./instance-key.js";
export type LocalStudyRuntimeProof = {
  localStudySessionId: string;
  machineId: string;
  keyId: string;
  chatSessionId: string;
};

/** The renderer names a reservation; this installation supplies its own identity. */
export async function localStudyRuntimeProof(
  target: unknown,
  chatSessionId: string | undefined,
): Promise<LocalStudyRuntimeProof | undefined> {
  if (
    !target ||
    typeof target !== "object" ||
    !("localStudySessionId" in target)
  )
    return undefined;
  if (HOSTED_MODE || !LOCAL_HARNESS_ENABLED)
    throw new Error("Local study execution is unavailable on this server.");
  const localStudySessionId = target.localStudySessionId;
  if (
    typeof localStudySessionId !== "string" ||
    !localStudySessionId ||
    !chatSessionId
  )
    throw new Error(
      "Authorize this study conversation before running locally.",
    );
  const identity = await readLocalInstanceIdentity();
  const keyId = identity.keyId ?? getRegisteredKeyId();
  if (!keyId)
    throw new Error(
      "Authorize this local installation before running the study.",
    );
  return {
    localStudySessionId,
    machineId: await getLocalMachineId(),
    keyId,
    chatSessionId,
  };
}
