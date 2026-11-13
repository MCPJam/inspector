/**
 * Reviewer sign-in attempts as the API returns them: MCPJam signing in as a
 * directory's reviewer for one submission, stage by stage. Credentials are
 * project secrets referenced by NAME; nothing here holds a secret's value.
 */
import { directorySubmissionsPath } from "./directory-submission-types.js";
import type { PlatformReadinessRunReceipt } from "./types.js";

export type PlatformReviewerAttemptState =
  | "running"
  | "waiting-for-person"
  | "passed"
  | "failed"
  | "expired"
  | "cancelled";

export interface PlatformReviewerStage {
  stage:
    | "credentials"
    | "connect-link"
    | "sign-in"
    | "verification"
    | "consent"
    | "connected"
    | "identity"
    | "fixtures"
    | "probe";
  status: "passed" | "failed" | "blocked" | "skipped";
  at: number;
  /** The run that recorded it. */
  runId: string;
  detail?: string;
  evidence?: {
    screenshotArtifactId?: string;
    recordingArtifactId?: string;
    observedIdentity?: string;
    observedOrganization?: string;
    httpStatus?: number;
    bodyExcerpt?: string;
  };
}

export interface PlatformReviewerAttempt {
  id: string;
  submissionId: string;
  projectId: string;
  /** The submission's saved server, copied when the attempt started. */
  serverId: string;
  /** The hosted-only account the reviewer's connection wrote its tokens to. */
  reviewerAccountId?: string;
  passwordSecretName: string;
  usernameSecretName?: string;
  username?: string;
  loginUrl?: string;
  tenant?: string;
  state: PlatformReviewerAttemptState;
  /** Oldest first. */
  stages: PlatformReviewerStage[];
  /** Why the attempt stopped for a person, and what they should do. */
  waitingFor?: { reason: string; action: string; since: number };
  runIds: string[];
  /** The run working on it now. */
  currentRunId?: string;
  /** Why it ended: an outcome, a cancel or an expiry. */
  detail?: string;
  /** When sign-in and connect first both passed. */
  testedAt?: number;
  /** An open attempt nothing changes by then expires. */
  expiresAt: number;
  createdBy: string;
  resumedBy?: string;
  resumedAt?: number;
  cancelledBy?: string;
  createdAt: number;
  updatedAt: number;
}

/** Secret NAMES and plain fields only. */
export interface PlatformReviewerAttemptCreateBody {
  passwordSecretName: string;
  /** Or the username as text, in `username`. */
  usernameSecretName?: string;
  username?: string;
  loginUrl?: string;
  /** The organization or tenant the reviewer must end up signed in to. */
  tenant?: string;
  idempotencyKey?: string;
}

/** An attempt and the run that works on it. */
export interface PlatformReviewerAttemptStart {
  attempt: PlatformReviewerAttempt;
  /** `null` when a replayed start names an attempt that has since ended. */
  run: PlatformReadinessRunReceipt | null;
  /** An idempotency key answered from an earlier start. */
  replayed?: true;
}

export function reviewerAttemptsPath(
  projectId: string,
  submissionId: string,
  attemptId?: string,
  action?: "resume" | "cancel"
): string {
  const base = `${directorySubmissionsPath(projectId, submissionId)}/reviewer-attempts`;
  if (attemptId === undefined) return base;
  const one = `${base}/${encodeURIComponent(attemptId)}`;
  return action ? `${one}/${action}` : one;
}
