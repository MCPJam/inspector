/**
 * Resuming a readiness run: the client posts to the run's own resume route
 * with no body, and the operation resolves the project the way every run
 * operation does and returns the receipt.
 */

import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  PlatformApiClient,
  isOperationAvailable,
  resumeReadinessRunOperation,
  type PlatformReadinessRun,
} from "../../src/platform/index.js";

const PROJECT = {
  id: "project-1",
  name: "Shop",
  description: null,
  icon: null,
  organizationId: "org-a",
  visibility: null,
  createdAt: 1,
  updatedAt: 1,
};

const RECEIPT = {
  runId: "run-1",
  projectId: "project-1",
  serverId: "server-1",
  readinessKind: "claude",
  status: "running",
  deduped: false,
  includeLlmObservations: false,
};

function makeClient() {
  const posts: Array<{ path: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (target: unknown, init?: RequestInit) => {
    const path = new URL(String(target)).pathname;
    if (path === "/api/v1/projects") return Response.json({ items: [PROJECT] });
    if (init?.method === "POST") {
      posts.push({ path, body: init.body });
      return Response.json(RECEIPT, { status: 202 });
    }
    return Response.json({ code: "NOT_FOUND", message: path }, { status: 404 });
  });
  const client = new PlatformApiClient({
    baseUrl: "https://api.example.com/api/v1",
    getAuth: () => "sk_test",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, posts };
}

describe("resume_readiness_run", () => {
  it("posts to the run's resume route with no body and returns the receipt", async () => {
    const { client, posts } = makeClient();
    const result = await resumeReadinessRunOperation.execute(
      { run: "run-1" },
      { client }
    );
    expect(posts).toEqual([
      {
        path: "/api/v1/projects/project-1/readiness-runs/run-1/resume",
        body: undefined,
      },
    ]);
    expect(result).toEqual({
      project: { id: "project-1", name: "Shop", organizationId: "org-a" },
      run: RECEIPT,
    });
  });

  it("is a write that spends nothing new and links nowhere", () => {
    expect(resumeReadinessRunOperation.readOnly).toBe(false);
    expect(resumeReadinessRunOperation.risk).toBe("none");
    expect(resumeReadinessRunOperation.permalink).toMatchObject({
      kind: "none",
      reason: "mutation-only",
    });
  });

  it("is available under either gate a run can start under", () => {
    // A server's run starts under `conformance`, a submission's under
    // `directory-readiness`; the backend checks which one this run needs.
    expect(isOperationAvailable("resume_readiness_run", {})).toBe(false);
    expect(
      isOperationAvailable("resume_readiness_run", { conformance: true })
    ).toBe(true);
    expect(
      isOperationAvailable("resume_readiness_run", {
        "directory-readiness": true,
      })
    ).toBe(true);
  });
});

describe("PlatformReadinessRun.resumable", () => {
  it("is optional: a deployment older than the field omits it", () => {
    expectTypeOf<PlatformReadinessRun["resumable"]>().toEqualTypeOf<
      boolean | undefined
    >();
  });
});
