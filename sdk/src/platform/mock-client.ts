/**
 * The mock server methods of `PlatformApiClient`, kept out of `client.ts` like
 * the directory submission methods: `PlatformApiClient` extends this class and
 * implements `request`, so these use the client's own auth, headers, deadline
 * and error mapping.
 */
import { DirectoryReviewerAttemptClient } from "./directory-reviewer-attempt-client.js";
import type {
  PlatformMockDefinition,
  PlatformMockSaved,
  PlatformMockServer,
} from "./mock-types.js";

type Options = { signal?: AbortSignal };

const mocksPath = (projectId: string, tail = "") =>
  `/projects/${encodeURIComponent(projectId)}/mock-servers${tail}`;

export abstract class MockServerClient extends DirectoryReviewerAttemptClient {
  createMockServer(
    params: {
      projectId: string;
      name: string;
      serverId?: string;
      definition: PlatformMockDefinition;
    },
    options?: Options
  ): Promise<PlatformMockSaved> {
    const { projectId, ...body } = params;
    return this.request("POST", mocksPath(projectId), { body }, options);
  }

  /** With `dryRun`, only reports what the save would change. */
  saveMockServerVersion(
    params: {
      projectId: string;
      mockId: string;
      definition?: PlatformMockDefinition;
      patch?: Record<string, unknown>;
      expectedVersion: number;
      dryRun?: boolean;
    },
    options?: Options
  ): Promise<PlatformMockSaved> {
    const { projectId, mockId, ...body } = params;
    const path = mocksPath(projectId, `/${encodeURIComponent(mockId)}/versions`);
    return this.request("POST", path, { body }, options);
  }

  /** One version (the head by default), and what changed since another. */
  getMockServer(
    params: {
      projectId: string;
      mockId: string;
      version?: number;
      sinceVersion?: number;
    },
    options?: Options
  ): Promise<PlatformMockServer> {
    const path = mocksPath(params.projectId, `/${encodeURIComponent(params.mockId)}`);
    const query = { version: params.version, since: params.sinceVersion };
    return this.request("GET", path, { query }, options);
  }
}
