import { beforeEach, describe, expect, it, vi } from "vitest";

// The worker tests stub out `runEvalSuite`, so nothing there can see what the
// REAL `defaultRunEvalSuite` hands to `prepareEvalRun`. The provenance label
// (`source: 'github_check'`) lives exactly in that gap: a regression back to
// 'api' would pass every existing test while silently mislabeling every check
// run in the dashboard — and dropping it from the stale-run watchdog's source
// gate on the backend. This file mocks the three integration boundaries and
// asserts on the actual call.

const prepareEvalRun = vi.fn();
const createAuthorizedManager = vi.fn();
const createConvexClient = vi.fn();

vi.mock("../../routes/shared/evals.js", () => ({
  prepareEvalRun: (...args: unknown[]) => prepareEvalRun(...args),
}));
vi.mock("../../routes/web/auth.js", () => ({
  createAuthorizedManager: (...args: unknown[]) =>
    createAuthorizedManager(...args),
}));
vi.mock("../evals/route-helpers.js", () => ({
  createConvexClient: (...args: unknown[]) => createConvexClient(...args),
}));

import { defaultRunEvalSuiteForTests } from "../github-checks-worker";

describe("defaultRunEvalSuite provenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createAuthorizedManager.mockResolvedValue({
      manager: { disconnectAllServers: vi.fn().mockResolvedValue(undefined) },
    });
    prepareEvalRun.mockResolvedValue({
      runId: "run-1",
      recorder: null,
      execute: vi.fn().mockResolvedValue(undefined),
    });
    // First query: snapshot ownership check (null environment → 'ours');
    // second: the terminal run read.
    createConvexClient.mockReturnValue({
      query: vi
        .fn()
        .mockResolvedValueOnce({ configSnapshot: { environment: null } })
        .mockResolvedValue({
          status: "completed",
          result: "passed",
          summary: { total: 2, passed: 2, failed: 0, passRate: 1 },
        }),
      mutation: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("passes source: 'github_check' (never 'api') to prepareEvalRun", async () => {
    const run = defaultRunEvalSuiteForTests();
    const result = await run({
      claimed: {
        triggerId: "trig-src",
        repoFullName: "mcpjam/mcp-check-fixture",
        prNumber: 1,
        headSha: "a".repeat(40),
        organizationId: "org-1",
        projectId: "proj-1",
        createdByExternalId: "user_x",
        suiteId: "suite-1",
      },
      bearer: "bearer-token",
      serverId: "srv-1",
      serverName: "gh-check-trig-src",
    });

    expect(prepareEvalRun).toHaveBeenCalledTimes(1);
    const request = prepareEvalRun.mock.calls[0][1] as Record<string, unknown>;
    expect(request.source).toBe("github_check");
    // The rest of the provenance-bearing contract, pinned alongside it:
    expect(request.idempotencyKey).toBe("trig-src");
    expect(request.suiteRerun).toBe(true);
    expect(request.refreshSnapshot).toBe(true);
    expect(result.result).toBe("passed");
  });
});
