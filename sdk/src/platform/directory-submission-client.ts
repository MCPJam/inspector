/**
 * The directory submission methods of `PlatformApiClient`, kept out of
 * `client.ts` like the server account methods: `PlatformApiClient` extends
 * this class and implements `request`, so these are ordinary client methods
 * with the client's own auth, headers, deadline and error mapping.
 */
import type { DirectoryFlow } from "../directory-readiness/flows/types.js";
import {
  directorySubmissionsPath as path,
  type PlatformDirectoryFlowSummary,
  type PlatformDirectorySubmissionConflict,
  type PlatformDirectorySubmissionCreateBody,
  type PlatformDirectorySubmissionDeleted,
  type PlatformDirectorySubmissionResults,
  type PlatformDirectorySubmissionRunBody,
  type PlatformDirectorySubmissionSummary,
  type PlatformDirectorySubmissionUpdateBody,
  type PlatformDirectorySubmissionView,
} from "./directory-submission-types.js";
import { isPlatformApiError } from "./errors.js";
import { ServerAccountClient } from "./server-account-client.js";
import type { PlatformPage, PlatformReadinessRunReceipt } from "./types.js";

type Scope = { projectId: string; submissionId: string };
type RequestOptions = { signal?: AbortSignal; idempotencyKey?: string };
type View = Promise<PlatformDirectorySubmissionView>;

export abstract class DirectorySubmissionClient extends ServerAccountClient {
  protected abstract override request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    init: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      /** Send the declared launcher, which labels an agent's answers. */
      declareLaunch?: boolean;
      onStatus?: (status: number) => void;
    },
    options?: RequestOptions
  ): Promise<T>;

  listDirectoryFlows(
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformDirectoryFlowSummary>> {
    return this.request("GET", "/directory-flows", {}, options);
  }

  /** One form, field by field: labels, rules, defaults and the portal's error lines. */
  getDirectoryFlow(
    params: { flowId: string },
    options?: RequestOptions
  ): Promise<DirectoryFlow> {
    const flowPath = `/directory-flows/${encodeURIComponent(params.flowId)}`;
    return this.request("GET", flowPath, {}, options);
  }

  createDirectorySubmission(
    params: { projectId: string } & PlatformDirectorySubmissionCreateBody,
    options?: RequestOptions
  ): View {
    // Picked, not spread: the body is strict, and a wider object would 400.
    const { projectId, flowId, serverId, title, idempotencyKey } = params;
    const body = { flowId, serverId, title, idempotencyKey };
    return this.request("POST", path(projectId), { body }, options);
  }

  listDirectorySubmissions(
    params: { projectId: string; serverId?: string; flowId?: string; limit?: number },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformDirectorySubmissionSummary>> {
    const { projectId, ...query } = params;
    return this.request("GET", path(projectId), { query }, options);
  }

  getDirectorySubmission(params: Scope, options?: RequestOptions): View {
    const { projectId, submissionId } = params;
    return this.request("GET", path(projectId, submissionId), {}, options);
  }

  /** A `409` carries the submission as it is now: see {@link directorySubmissionConflict}. */
  updateDirectorySubmission(
    params: Scope & PlatformDirectorySubmissionUpdateBody,
    options?: RequestOptions
  ): View {
    const { projectId, submissionId, expectedRevision } = params;
    const { answers, confirm, title, idempotencyKey } = params;
    const body = { expectedRevision, answers, confirm, title, idempotencyKey };
    const target = path(projectId, submissionId);
    return this.request("PATCH", target, { body, declareLaunch: true }, options);
  }

  deleteDirectorySubmission(
    params: Scope,
    options?: RequestOptions
  ): Promise<PlatformDirectorySubmissionDeleted> {
    const { projectId, submissionId } = params;
    return this.request("DELETE", path(projectId, submissionId), {}, options);
  }

  /** Grade the submission's saved server and answers. Poll the run it names. */
  startDirectorySubmissionRun(
    params: Scope & PlatformDirectorySubmissionRunBody,
    options?: RequestOptions
  ): Promise<PlatformReadinessRunReceipt> {
    const { projectId, submissionId, idempotencyKey, includeLlmObservations } =
      params;
    const body = { idempotencyKey, includeLlmObservations };
    const target = path(projectId, submissionId, "runs");
    return this.request("POST", target, { body }, options);
  }

  /** The latest complete run's findings by step, or those of `runId`. */
  getDirectorySubmissionResults(
    params: Scope & { runId?: string },
    options?: RequestOptions
  ): Promise<PlatformDirectorySubmissionResults> {
    const { projectId, submissionId, runId } = params;
    const target = path(projectId, submissionId, "results");
    return this.request("GET", target, { query: { runId } }, options);
  }
}

/** The conflict an update was refused with, or `undefined` for any other error. */
export function directorySubmissionConflict(
  error: unknown
): PlatformDirectorySubmissionConflict | undefined {
  const details = isPlatformApiError(error) && error.status === 409
    ? error.details
    : undefined;
  if (typeof details?.currentRevision !== "number") return undefined;
  const keys = Array.isArray(details.conflictingKeys)
    ? details.conflictingKeys
    : [];
  return {
    currentRevision: details.currentRevision,
    conflictingKeys: keys.filter((key) => typeof key === "string"),
    ...(details.current && typeof details.current === "object"
      ? { current: details.current as PlatformDirectorySubmissionView }
      : {}),
  };
}
