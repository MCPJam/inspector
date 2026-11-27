/**
 * The mock server methods of `PlatformApiClient`, kept out of `client.ts` like
 * the directory submission methods: `PlatformApiClient` extends this class and
 * implements `request`, so these use the client's own auth, headers, deadline
 * and error mapping.
 */
import { DirectoryReviewerAttemptClient } from "./directory-reviewer-attempt-client.js";
import type {
  PlatformMockDefinition,
  PlatformMockForwarding,
  PlatformMockFamily,
  PlatformMockForwardingPolicy,
  PlatformMockPatched,
  PlatformMockRead,
  PlatformMockReadSelector,
  PlatformMockRefresh,
  PlatformMockRun,
  PlatformMockRunClosed,
  PlatformMockWritten,
} from "./mock-types.js";

type Options = { signal?: AbortSignal };

const project = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;
const mocksPath = (projectId: string, tail = "") => `${project(projectId)}/mock-servers${tail}`;

export abstract class MockServerClient extends DirectoryReviewerAttemptClient {
  /** From a saved server (`serverId`) or from nothing. */
  createMockServer(
    params: {
      projectId: string;
      name: string;
      serverId?: string;
      definition: PlatformMockDefinition;
    },
    options?: Options
  ): Promise<PlatformMockWritten> {
    const { projectId, ...body } = params;
    return this.request("POST", mocksPath(projectId), { body }, options);
  }

  /**
   * The next version, from a whole definition or an RFC 7396 merge patch,
   * against the head version the caller read.
   */
  saveMockServerVersion(
    params: {
      projectId: string;
      mockId: string;
      definition?: PlatformMockDefinition;
      patch?: Record<string, unknown>;
      expectedVersion: number;
    },
    options?: Options
  ): Promise<PlatformMockWritten> {
    const { projectId, mockId, ...body } = params;
    const path = mocksPath(projectId, `/${encodeURIComponent(mockId)}/versions`);
    return this.request("POST", path, { body }, options);
  }

  /**
   * One bounded read of a version (the head by default): the summary, or with a
   * selector a page of names, one entry, or one field or nested path.
   */
  getMockServer(
    params: { projectId: string; mockId: string } & PlatformMockReadSelector,
    options?: Options
  ): Promise<PlatformMockRead> {
    const { projectId, mockId, path, ...query } = params;
    const encoded = Array.isArray(path) ? JSON.stringify(path) : path;
    return this.request(
      "GET",
      mocksPath(projectId, `/${encodeURIComponent(mockId)}`),
      { query: { ...query, path: encoded } },
      options
    );
  }

  /**
   * Set or remove exactly one path (an entry, a field or a nested path)
   * against the head version the caller read, without sending the entry.
   */
  patchMockServer(
    params: {
      projectId: string;
      mockId: string;
      expectedVersion: number;
      family?: PlatformMockFamily;
      name?: string;
      path?: string[];
      value?: unknown;
      remove?: boolean;
    },
    options?: Options
  ): Promise<PlatformMockPatched> {
    const { projectId, mockId, ...body } = params;
    return this.request("PATCH", mocksPath(projectId, `/${encodeURIComponent(mockId)}`), { body }, options);
  }

  /**
   * Re-read the real server as the caller and compare it with the listing the
   * version saved. Only previews unless `apply` is set, which saves the new
   * listing as the next version against `expectedVersion`.
   */
  refreshMockServer(
    params: { projectId: string; mockId: string; expectedVersion: number; apply?: boolean },
    options?: Options
  ): Promise<PlatformMockRefresh> {
    const { projectId, mockId, ...body } = params;
    return this.request("POST", mocksPath(projectId, `/${encodeURIComponent(mockId)}/refresh`), { body }, options);
  }

  /**
   * Open a test run on a version (the head by default): its own copy of the
   * version's records, at a URL only the caller can use for 24 hours.
   */
  openMockRun(
    params: { projectId: string; mockId: string; version?: number; platformRunId?: string },
    options?: Options
  ): Promise<PlatformMockRun> {
    const { projectId, mockId, ...body } = params;
    return this.request("POST", mocksPath(projectId, `/${encodeURIComponent(mockId)}/runs`), { body }, options);
  }

  /** Restore the run's pinned seed. Returns the next epoch's URL; the old one is refused. */
  resetMockRun(
    params: { projectId: string; mockId: string; runId: string; expectedEpoch: number },
    options?: Options
  ): Promise<PlatformMockRun> {
    const { projectId, mockId, runId, expectedEpoch } = params;
    const path = mocksPath(projectId, `/${encodeURIComponent(mockId)}/runs/${encodeURIComponent(runId)}/reset`);
    return this.request("POST", path, { body: { expectedEpoch } }, options);
  }

  /** End the run's access at once. Repeating it is safe. */
  closeMockRun(
    params: { projectId: string; mockId: string; runId: string },
    options?: Options
  ): Promise<PlatformMockRunClosed> {
    const { projectId, mockId, runId } = params;
    const path = mocksPath(projectId, `/${encodeURIComponent(mockId)}/runs/${encodeURIComponent(runId)}/close`);
    return this.request("POST", path, { body: {} }, options);
  }

  /** The policy in force for a mock, or for the project's workspace when no mock is named. */
  getMockForwardingPolicy(
    params: { projectId: string; mockId?: string },
    options?: Options
  ): Promise<PlatformMockForwardingPolicy> {
    const path = params.mockId
      ? mocksPath(params.projectId, `/${encodeURIComponent(params.mockId)}/forwarding-policy`)
      : `${project(params.projectId)}/mock-forwarding-policy`;
    return this.request("GET", path, {}, options);
  }

  /** Admin only: allow or block every mock in the project's workspace calling its real server. */
  setMockForwardingPolicy(
    params: { projectId: string; forwarding: PlatformMockForwarding },
    options?: Options
  ): Promise<PlatformMockForwardingPolicy> {
    const { projectId, forwarding } = params;
    return this.request("PUT", `${project(projectId)}/mock-forwarding-policy`, { body: { forwarding } }, options);
  }
}
