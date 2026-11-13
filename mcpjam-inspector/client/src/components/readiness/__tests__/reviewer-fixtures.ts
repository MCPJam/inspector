/**
 * Sample reviewer sign-in attempts and secret rows for the reviewer path's
 * tests. Names and ids are sample values.
 */
import type { ProjectSecretView } from "@/hooks/useProjectSecrets";
import type { ReviewerAttempt } from "@/lib/apis/reviewer-attempts-api";

/** Noon UTC, so the date reads Nov 13 in every test time zone near it. */
export const NOV_13 = Date.UTC(2026, 10, 13, 12);
export const SCOPE = { projectId: "proj_1", submissionId: "sub_1" };
export const EMAIL_SECRET = "MCPJAM_REVIEWER_SUB_1_EMAIL";
export const PASSWORD_SECRET = "MCPJAM_REVIEWER_SUB_1_PASSWORD";

export function attemptIn(
  state: ReviewerAttempt["state"],
  rest: Partial<ReviewerAttempt> = {},
): ReviewerAttempt {
  return {
    id: "att_1",
    submissionId: SCOPE.submissionId,
    projectId: SCOPE.projectId,
    serverId: "srv_1",
    usernameSecretName: EMAIL_SECRET,
    passwordSecretName: PASSWORD_SECRET,
    state,
    stages: [],
    runIds: ["run_1"],
    currentRunId: state === "running" ? "run_1" : undefined,
    expiresAt: NOV_13 + 86_400_000,
    createdBy: "user_1",
    createdAt: NOV_13,
    updatedAt: NOV_13,
    ...rest,
  };
}

/** Paused at a verification code, as the sign-in rehearsal records it. */
export const WAITING = attemptIn("waiting-for-person", {
  waitingFor: {
    reason: "The sign-in page asked for a verification code.",
    action: "Finish the sign-in from the single-use link, then resume.",
    since: NOV_13,
  },
  updatedAt: NOV_13 + 1,
});

export function secretRow(
  name: string,
  rest: Partial<ProjectSecretView> = {},
): ProjectSecretView {
  return {
    secretId: `secret_${name}`,
    projectId: SCOPE.projectId,
    name,
    delivery: "materialized",
    sharing: "project",
    isOwner: false,
    createdAt: NOV_13,
    updatedAt: NOV_13,
    createdByUserId: "user_1",
    updatedByUserId: "user_1",
    ...rest,
  };
}
