/**
 * The reviewer sign-in attempt methods of `PlatformApiClient`, kept out of
 * `client.ts` like the submission methods they extend.
 */
import { DirectorySubmissionClient } from "./directory-submission-client.js";
import {
  reviewerAttemptsPath as path,
  type PlatformReviewerAttempt,
  type PlatformReviewerAttemptCreateBody,
  type PlatformReviewerAttemptStart,
} from "./directory-reviewer-attempt-types.js";
import type { PlatformPage } from "./types.js";

type Submission = { projectId: string; submissionId: string };
type Attempt = Submission & { attemptId: string };
type RequestOptions = { signal?: AbortSignal };

export abstract class DirectoryReviewerAttemptClient extends DirectorySubmissionClient {
  /** Start an attempt with secret names, and the run that signs in. */
  createDirectoryReviewerAttempt(
    params: Submission & PlatformReviewerAttemptCreateBody,
    options?: RequestOptions
  ): Promise<PlatformReviewerAttemptStart> {
    // Picked, not spread: the body is strict and takes secret names only.
    const { projectId, submissionId, passwordSecretName, usernameSecretName } = params;
    const { username, loginUrl, tenant, idempotencyKey } = params;
    const body = { passwordSecretName, usernameSecretName, username, loginUrl, tenant, idempotencyKey };
    return this.request("POST", path(projectId, submissionId), { body }, options);
  }

  /** Newest first. */
  listDirectoryReviewerAttempts(
    params: Submission & { limit?: number },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformReviewerAttempt>> {
    const { projectId, submissionId, limit } = params;
    return this.request("GET", path(projectId, submissionId), { query: { limit } }, options);
  }

  getDirectoryReviewerAttempt(params: Attempt, options?: RequestOptions): Promise<PlatformReviewerAttempt> {
    const { projectId, submissionId, attemptId } = params;
    return this.request("GET", path(projectId, submissionId, attemptId), {}, options);
  }

  /** Hand an attempt waiting for a person back to a new run. */
  resumeDirectoryReviewerAttempt(
    params: Attempt,
    options?: RequestOptions
  ): Promise<PlatformReviewerAttemptStart> {
    const { projectId, submissionId, attemptId } = params;
    return this.request("POST", path(projectId, submissionId, attemptId, "resume"), {}, options);
  }

  createDirectoryReviewerHandoff(params: Attempt, options?: RequestOptions): Promise<{ handoffUrl: string; expiresAt: number }> {
    const { projectId, submissionId, attemptId } = params;
    return this.request("POST", path(projectId, submissionId, attemptId, "handoff"), {}, options);
  }

  cancelDirectoryReviewerAttempt(params: Attempt, options?: RequestOptions): Promise<PlatformReviewerAttempt> {
    const { projectId, submissionId, attemptId } = params;
    return this.request("POST", path(projectId, submissionId, attemptId, "cancel"), {}, options);
  }
}
