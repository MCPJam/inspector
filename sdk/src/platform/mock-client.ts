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
  PlatformMockForwardingPolicy,
  PlatformMockRead,
  PlatformMockReadSelector,
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
