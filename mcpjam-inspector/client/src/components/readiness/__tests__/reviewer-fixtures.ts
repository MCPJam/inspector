/**
 * Sample reviewer sign-in attempts and secret rows for the reviewer path's
 * tests. Names and ids are sample values; stage details are the sign-in
 * rehearsal's own wording.
 */
import {
  CLAUDE_CONNECTOR_FLOW,
  gradeDirectoryReviewerPath,
  placeDirectoryResults,
  type DirectoryReviewerIdentityEvidence,
} from "@mcpjam/sdk/browser";
import type { ProjectSecretView } from "@/hooks/useProjectSecrets";
import type { ReviewerAttempt } from "@/lib/apis/reviewer-attempts-api";
import type { ReviewerStage } from "../reviewer-stages";

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

/** The desktop reservation whose recording the sample frames point into. */
export const RESERVATION = "res_1";

/** A stage run 1 recorded, with its frame of the recording when it has one. */
export function stage(
  name: ReviewerStage["stage"],
  status: ReviewerStage["status"],
  detail: string,
  seconds?: number,
  runId = "run_1",
): ReviewerStage {
  const frame =
    seconds === undefined
      ? {}
      : { screenshotArtifactId: `${RESERVATION}#t=${seconds.toFixed(1)}` };
  return {
    stage: name,
    status,
    at: NOV_13,
    runId,
    detail,
    evidence: { recordingArtifactId: RESERVATION, ...frame },
  };
}

export const OPENED = stage(
  "connect-link",
  "passed",
  "MCPJam opened the authorization server's sign-in page in a clean browser.",
  2.1,
);
export const SIGNED_IN = stage(
  "sign-in",
  "passed",
  "MCPJam signed in with the reviewer's saved credentials.",
  9.4,
);
export const CONSENTED = stage(
  "consent",
  "passed",
  'MCPJam approved access on the consent page ("Allow").',
  14.8,
);
export const CONNECTED = stage(
  "connected",
  "passed",
  "MCPJam signed in as the reviewer and connected the reviewer account.",
);

/** Signed in, consented and connected, then passed by the run. */
export const PASSED = attemptIn("passed", {
  stages: [OPENED, SIGNED_IN, CONSENTED, CONNECTED],
  testedAt: NOV_13,
  reviewerAccountId: "acct_1",
});

export const ASKED =
  'The sign-in page asked for a verification step MCPJam cannot complete: "Enter the code we sent to your email".';
export const ACTION =
  "Sign in as the reviewer and complete the verification, or turn it off for the reviewer account. Then resume this attempt.";

/** Paused at a verification code, as the sign-in rehearsal records it. */
export const WAITING = attemptIn("waiting-for-person", {
  stages: [OPENED, SIGNED_IN, stage("verification", "blocked", ASKED, 11.2)],
  waitingFor: { reason: ASKED, action: ACTION, since: NOV_13 },
  updatedAt: NOV_13 + 1,
});

export const REFUSED_DETAIL =
  'The sign-in page refused the reviewer\'s credentials: "Incorrect email or password". Check the saved username and password, then start a new attempt.';

/** The password was refused: the attempt failed at the sign-in. */
export const REFUSED = attemptIn("failed", {
  stages: [OPENED, stage("sign-in", "failed", REFUSED_DETAIL, 8.6)],
  detail: REFUSED_DETAIL,
});

const CHECK = {
  title: "Sample reviewer check",
  lane: "submission-artifacts",
  class: "required",
  source: {},
  provenance: "wire",
} as const;

/** The latest run's results with P4's identity check, graded and placed. */
export function identityResults(identity: DirectoryReviewerIdentityEvidence) {
  const findings = gradeDirectoryReviewerPath(
    { reviewerPath: { account: { id: "acct_1" }, identity } },
    {
      identity: { ...CHECK, id: "both.reviewer.identity" },
      fixtures: { ...CHECK, id: "both.reviewer.fixtures" },
      clientSignatures: { ...CHECK, id: "both.auth.client-signatures" },
    },
    {
      engineVersion: "sample",
      stamp: { evaluatedAt: new Date(NOV_13).toISOString() },
    },
  );
  return placeDirectoryResults({
    flow: CLAUDE_CONNECTOR_FLOW,
    answers: [],
    findings,
  });
}

const CALL = { tool: "get_me", arguments: {} };
const EXPECTED = { identity: "review@example.com", organization: "Review Org" };

export const VERIFIED = identityResults({
  outcome: "verified",
  call: CALL,
  observed: EXPECTED,
  expected: EXPECTED,
});

export const WRONG_TENANT = identityResults({
  outcome: "wrong-tenant",
  call: CALL,
  observed: { identity: "review@example.com", organization: "Other Org" },
  expected: EXPECTED,
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
