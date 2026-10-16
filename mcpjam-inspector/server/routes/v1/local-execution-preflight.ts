import { localHarnessCapabilityRefusal } from "../../../shared/harness-capability-support.js";
import { localExecutionTargetBodySchema } from "@mcpjam/sdk/platform";
import type { z } from "zod";
import { verifyLocalHarnessMember } from "../../utils/harness/local/readiness.js";
import { readRuntimeInstallStatus } from "../../utils/harness/local/runtime-install.js";
import { resolveLocalHarnessAvailability } from "../../utils/harness/local/availability.js";
import { readInstalledAdapterVersion } from "../../utils/harness/local/local-turn.js";
import { ErrorCode, WebRouteError } from "../web/errors.js";

type LocalTarget = z.infer<typeof localExecutionTargetBodySchema>;
export function assertPlatformExecutionVenue(
  pinned: "hosted" | "local" | undefined,
  requested: "hosted" | "local-native" | undefined,
) {
  const venue = requested ?? "hosted";
  if (pinned !== undefined && pinned !== (venue === "local-native" ? "local" : "hosted")) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Continue on the session's original execution venue; re-send its local execution target on every local turn.",
      { reason: "EXECUTION_TARGET_REQUIRED" },
    );
  }
  return venue;
}

function assertLocalCapabilities(
  harnessId: string,
  hostConfig: Record<string, unknown>,
) {
  const refusal = localHarnessCapabilityRefusal(harnessId, {
    builtInToolIds: Array.isArray(hostConfig.builtInToolIds)
      ? hostConfig.builtInToolIds.filter(
          (id): id is string => typeof id === "string",
        )
      : [],
    browserToolPolicy: hostConfig.browserToolPolicy,
  });
  if (refusal)
    throw new WebRouteError(422, ErrorCode.FEATURE_NOT_SUPPORTED, refusal, {
      reason: "LOCAL_CAPABILITY_UNSUPPORTED",
    });
}

/** This read-only preflight runs before the API allocates a turn lease. */
export async function preflightLocalExecution(args: {
  target: LocalTarget;
  grantToken: string | undefined;
  bearer: string;
  projectId: string;
  hostConfig: Record<string, unknown> | undefined;
}) {
  const { target, grantToken, bearer, projectId, hostConfig } = args;
  if (!grantToken)
    throw new WebRouteError(
      401,
      ErrorCode.UNAUTHORIZED,
      "A local execution grant is required",
      { reason: "LOCAL_GRANT_REQUIRED" },
    );
  if (hostConfig?.harness !== target.harnessId) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "The execution target must match the selected client's harness",
      { reason: "LOCAL_HARNESS_MISMATCH" },
    );
  }
  if (hostConfig.requireToolApproval === true) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "This client requires attended approvals and cannot run on an unattended API turn",
      { reason: "ATTENDED_APPROVAL_REQUIRED" },
    );
  }
  assertLocalCapabilities(target.harnessId, hostConfig);
  const actor = await verifyLocalHarnessMember(
    bearer,
    projectId,
    undefined,
    target.harnessId,
  );
  const status = await readRuntimeInstallStatus({
    harnessId: target.harnessId,
    preferRuntimeId: target.runtimeId,
  });
  if (status.state !== "ready")
    throw new WebRouteError(
      409,
      ErrorCode.CONFLICT,
      "The selected local runtime is unavailable",
      { reason: "LOCAL_RUNTIME_UNAVAILABLE" },
    );
  const availability = await resolveLocalHarnessAvailability({
    target,
    scope: "unattended",
    userId: actor.userId,
    projectId,
    grantToken,
    actor: {
      isGuest: false,
      isScenarioSession: false,
      isJourneySession: false,
    },
    runtimeRoot: status.runtimeRoot,
    runtimeDigest: status.digest,
    installedAdapterVersion: await readInstalledAdapterVersion(
      target.harnessId,
    ),
  });
  if (!availability.available)
    throw new WebRouteError(409, ErrorCode.CONFLICT, availability.message, {
      reason: availability.status,
    });
  return { ...target, grantToken, actingUserId: actor.userId };
}
