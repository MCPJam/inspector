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
import type {
  PlatformDirectorySubmissionEvent as SubmissionEvent,
  PlatformDirectorySubmissionEventBody,
  PlatformDirectorySubmissionExportFile,
  PlatformDirectorySubmissionFinding as Finding,
  PlatformDirectorySubmissionFindingsQuery,
  PlatformDirectorySubmissionHandoff,
  PlatformDirectorySubmissionSnapshotsView,
} from "./directory-submission-handoff-types.js";
import type { DirectorySnapshotLabel } from "../directory-readiness/handoff.js";
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
    const { answers, confirm, title, checkGate, plugin, attempt, idempotencyKey } = params;
    // `null` is kept, since it clears; `undefined` drops out of the JSON.
    const body = {
      expectedRevision,
      answers,
      confirm,
      title,
      checkGate,
      plugin,
      attempt,
      idempotencyKey,
    };
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

  /**
   * Grade the submission's saved server and answers, and for a ChatGPT plugin
   * the stored version `pluginVersionId` names. Poll the run it names.
   */
  startDirectorySubmissionRun(
    params: Scope & PlatformDirectorySubmissionRunBody,
    options?: RequestOptions
  ): Promise<PlatformReadinessRunReceipt> {
    const { projectId, submissionId, idempotencyKey } = params;
    const { includeLlmObservations, pluginVersionId } = params;
    const body = { idempotencyKey, includeLlmObservations, pluginVersionId };
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

  /** Where to resume: status, counts, blockers, missing answers and next actions, built on each read. */
  getDirectorySubmissionHandoff(
    params: Scope,
    options?: RequestOptions
  ): Promise<PlatformDirectorySubmissionHandoff> {
    const target = path(params.projectId, params.submissionId, "handoff");
    return this.request("GET", target, {}, options);
  }

  /** One page of the stored results, newest first. Pass `nextCursor` back as `cursor`. */
  listDirectorySubmissionFindings(
    params: Scope & PlatformDirectorySubmissionFindingsQuery,
    options?: RequestOptions
  ): Promise<PlatformPage<Finding>> {
    const { projectId, submissionId, status, step, lane, cursor, limit } = params;
    const query = { status, step, lane, cursor, limit };
    return this.request("GET", path(projectId, submissionId, "findings"), { query }, options);
  }

  /** One check's stored result, with the observation behind it. */
  getDirectorySubmissionFinding(
    params: Scope & { checkId: string },
    options?: RequestOptions
  ): Promise<Finding> {
    const findings = path(params.projectId, params.submissionId, "findings");
    return this.request("GET", `${findings}/${encodeURIComponent(params.checkId)}`, {}, options);
  }

  /** The pack as a file, JSON unless `format` says otherwise: save `content` as it is. */
  exportDirectorySubmission(
    params: Scope & { format?: "json" | "markdown" },
    options?: RequestOptions
  ): Promise<PlatformDirectorySubmissionExportFile> {
    const target = path(params.projectId, params.submissionId, "export");
    return this.request("GET", target, { query: { format: params.format } }, options);
  }

  /** Recorded events, newest first, at most 100. */
  listDirectorySubmissionEvents(
    params: Scope & { kind?: SubmissionEvent["kind"]; limit?: number },
    options?: RequestOptions
  ): Promise<PlatformPage<SubmissionEvent>> {
    const { projectId, submissionId, kind, limit } = params;
    return this.request("GET", path(projectId, submissionId, "events"), { query: { kind, limit } }, options);
  }

  /** Record what happened in the directory, as seen or as relayed. Never a secret's value. */
  recordDirectorySubmissionEvent(
    params: Scope & PlatformDirectorySubmissionEventBody,
    options?: RequestOptions
  ): Promise<SubmissionEvent> {
    // Picked, not spread: the body is strict, and a wider object would 400.
    const { projectId, submissionId, kind, reportedOrObserved, state, uncertain } = params;
    const { directoryLabel, detail, link, reference, evidence, snapshot, finding, idempotencyKey } = params;
    const body = {
      kind, reportedOrObserved, state, uncertain, directoryLabel, detail,
      link, reference, evidence, snapshot, finding, idempotencyKey,
    };
    const target = path(projectId, submissionId, "events");
    return this.request("POST", target, { body, declareLaunch: true }, options);
  }

  /** The latest snapshot under each label; `compare` adds the diff between two labels' revisions. */
  getDirectorySubmissionSnapshots(
    params: Scope & { compare?: [DirectorySnapshotLabel, DirectorySnapshotLabel] },
    options?: RequestOptions
  ): Promise<PlatformDirectorySubmissionSnapshotsView> {
    const target = path(params.projectId, params.submissionId, "snapshots");
    return this.request("GET", target, { query: { compare: params.compare?.join(",") } }, options);
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
