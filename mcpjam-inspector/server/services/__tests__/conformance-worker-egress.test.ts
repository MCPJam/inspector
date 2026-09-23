/**
 * MJ-001: the two workers that start persisted conformance runs hand the
 * executor a GUARDED server config, not a bare `{ url }`.
 *
 * The executor now puts an unguarded config behind the hosted guard itself
 * (`conformance-run-executor-egress.test.ts`), so these are the explicit half:
 * each worker states which transport its target is dialled through, and that
 * transport refuses what the hosted guard refuses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { executePersistedConformanceRunMock } = vi.hoisted(() => ({
  executePersistedConformanceRunMock: vi.fn(),
}));

vi.mock("../conformance-run-executor.js", () => ({
  executePersistedConformanceRun: (...args: unknown[]) =>
    executePersistedConformanceRunMock(...args),
}));

const ORIGINAL_HOSTED_MODE = process.env.VITE_MCPJAM_HOSTED_MODE;

/**
 * `HOSTED_MODE` is read at import, and the guard no-ops outside it. Each case
 * therefore loads its worker into a fresh module graph, which is slow — hence
 * the explicit timeouts below.
 */
async function withHostedModules() {
  process.env.VITE_MCPJAM_HOSTED_MODE = "true";
  vi.resetModules();
  return await import("../../utils/hosted-egress-guard.js");
}

/** The server config the worker handed the executor. */
function serverPassed(): {
  url?: string;
  accessToken?: string;
  baseFetch?: typeof fetch;
} {
  expect(executePersistedConformanceRunMock).toHaveBeenCalledTimes(1);
  return executePersistedConformanceRunMock.mock.calls[0]![0].server;
}

async function expectRefusesLoopback(
  transport: typeof fetch | undefined,
  BlockedEgressTargetError: new (...args: never[]) => Error,
) {
  expect(typeof transport).toBe("function");
  await expect(transport!("https://127.0.0.1:6274/mcp")).rejects.toBeInstanceOf(
    BlockedEgressTargetError,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  executePersistedConformanceRunMock.mockResolvedValue({ runId: "run_1" });
});

afterEach(() => {
  if (ORIGINAL_HOSTED_MODE === undefined) {
    delete process.env.VITE_MCPJAM_HOSTED_MODE;
  } else {
    process.env.VITE_MCPJAM_HOSTED_MODE = ORIGINAL_HOSTED_MODE;
  }
  vi.resetModules();
});

describe("benchmark conformance child", () => {
  it("dials the benchmarked connector through the hosted conformance guard", async () => {
    const { BlockedEgressTargetError } = await withHostedModules();
    const { defaultRunConformanceChildForTests } = await import(
      "../bench-worker.js"
    );

    await defaultRunConformanceChildForTests()({
      job: {
        runnerBearer: "runner-bearer",
        projectId: "p1",
        serverId: "s1",
        benchmarkRunId: "bench_1",
      } as never,
      entry: { evidenceKey: "conformance" } as never,
      spec: {
        serverUrl: "https://connector.example.test/mcp",
        suites: ["protocol", "apps", "tasks"],
      },
    });

    const server = serverPassed();
    expect(server.url).toBe("https://connector.example.test/mcp");
    await expectRefusesLoopback(server.baseFetch, BlockedEgressTargetError);
  }, 90_000);
});

describe("GitHub checks conformance step", () => {
  it("dials the pull request's server through the hosted conformance guard", async () => {
    const { BlockedEgressTargetError } = await withHostedModules();
    const { defaultRunConformanceForTests } = await import(
      "../github-checks-worker.js"
    );

    await defaultRunConformanceForTests()({
      claimed: {
        projectId: "p1",
        triggerId: "trig_1",
        repoFullName: "acme/widgets",
      } as never,
      bearer: "execution-bearer",
      serverUrl: "https://3001-sb_1.e2b.app/mcp",
      candidateId: "cand_1",
      oauthAccessToken: "pr-server-token",
    });

    const server = serverPassed();
    expect(server.url).toBe("https://3001-sb_1.e2b.app/mcp");
    expect(server.accessToken).toBe("pr-server-token");
    await expectRefusesLoopback(server.baseFetch, BlockedEgressTargetError);
  }, 90_000);
});
