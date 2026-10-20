import {
  participantSafeStudyError,
  type ScenarioSandboxPlan,
} from "../../utils/scenario-runtime-config.js";
import { ErrorCode, WebRouteError } from "./errors.js";

/**
 * The refusal for a scenario HARNESS turn whose conversation box cannot be
 * used. Named per cause, because each one has a different fix and none of
 * them is "run it on your own computer".
 */
export function scenarioHarnessBoxRefusal(
  harness: string,
  reason: ScenarioSandboxPlan["suppressReason"],
): WebRouteError {
  const subject = `This scenario runs the ${harness} harness on a disposable computer`;
  switch (reason) {
    case "sandbox_mode_unavailable":
      return new WebRouteError(
        409,
        ErrorCode.CONFLICT,
        `${subject}, and its environment's computer image can't boot right now. Fix or rebuild the image, then retry.`,
        { reason: "SANDBOX_IMAGE_UNAVAILABLE" },
      );
    case "not_a_data_plane":
      return new WebRouteError(
        503,
        ErrorCode.FEATURE_NOT_SUPPORTED,
        `${subject}, which this server can't run. Open the scenario in the MCPJam web app.`,
        { reason: "NOT_A_DATA_PLANE" },
      );
    case "secrets_unavailable":
      return new WebRouteError(
        503,
        ErrorCode.INTERNAL_ERROR,
        `${subject}, and this turn couldn't confirm which of the environment's secrets it may hold. Retry in a moment.`,
        { reason: "SECRETS_UNAVAILABLE" },
      );
    default:
      return new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        `${subject}, which belongs to one conversation, and this turn named none.`,
        { reason: "NO_CHAT_SESSION_ID" },
      );
  }
}

export function scenarioHarnessProvisionRefusal(
  harness: string,
  refusal: { status: number; error: string; code?: string } | undefined,
  /** A non-member participant: never shown the owner-facing detail. */
  participant = false,
): WebRouteError {
  const participantMessage = participant
    ? participantSafeStudyError(refusal ?? {})
    : undefined;
  // A PARTICIPANT past the scenario's caps. The backend's sentence already
  // says which cap and when to come back; it is the whole message.
  if (refusal?.status === 429) {
    return new WebRouteError(
      429,
      ErrorCode.RATE_LIMITED,
      participantMessage ??
        (refusal.error ||
          "This scenario has reached its limit for participant sessions. Try again later."),
      {
        reason: "SCENARIO_PARTICIPANT_CAP",
        ...(refusal.code ? { code: refusal.code } : {}),
      },
    );
  }
  // A refusal that names a fix (an image, a secret, access) keeps its status.
  if (refusal?.status === 409 || refusal?.status === 403) {
    return new WebRouteError(
      refusal.status,
      refusal.status === 409 ? ErrorCode.CONFLICT : ErrorCode.FORBIDDEN,
      participantMessage ??
        `This scenario runs the ${harness} harness on a disposable computer, and one couldn't be started: ${refusal.error}`,
      {
        reason: "SANDBOX_PROVISION_FAILED",
        ...(refusal.code ? { code: refusal.code } : {}),
      },
    );
  }
  const atCapacity = refusal?.status === 503;
  return new WebRouteError(
    atCapacity ? 503 : 502,
    atCapacity ? ErrorCode.RATE_LIMITED : ErrorCode.INTERNAL_ERROR,
    participantMessage ??
      `This scenario runs the ${harness} harness on a disposable computer, and one couldn't be started` +
        (refusal?.error ? `: ${refusal.error}` : ".") +
        (atCapacity ? " Retry in a moment." : ""),
    {
      reason: "SANDBOX_PROVISION_FAILED",
      ...(refusal?.code ? { code: refusal.code } : {}),
    },
  );
}
