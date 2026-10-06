/**
 * A suite launch whose server cannot be listed is refused before the run
 * exists: starting the run reserves iterations and charges `eval_step`, and
 * the runner would only fail the same server at setup afterwards.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
  action: vi.fn(),
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    query = mocks.query;
    mutation = mocks.mutation;
    action = mocks.action;
  },
}));

import {
  prepareEvalRun,
  runEvalsWithManager,
  shouldSkipExecution,
} from "../evals";
import { WebRouteError } from "../../web/errors";

function manager(args: {
  listTools: () => Promise<unknown>;
  status: "connected" | "disconnected";
}) {
  return {
    listServers: () => ["s1"],
    hasServer: () => true,
    getConnectionStatus: () => args.status,
    listTools: args.listTools,
  };
}

const request = (overrides: Record<string, unknown> = {}) =>
  ({
    suiteId: "suite-1",
    suiteRerun: true,
    serverIds: ["s1"],
    serverNames: ["Linear"],
    tests: [],
    convexAuthToken: "token",
    orgModelConfig: { providers: [] },
    ...overrides,
  }) as never;

function launch(
  clientManager: ReturnType<typeof manager>,
  overrides: Record<string, unknown> = {},
) {
  return prepareEvalRun(clientManager as never, request(overrides));
}

const disconnected = () =>
  manager({
    listTools: async () => {
      throw new Error('MCP server "s1" is not connected.');
    },
    status: "disconnected",
  });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CONVEX_URL = "https://test.convex.cloud";
  process.env.CONVEX_HTTP_URL = "https://test.convex.site";
  mocks.query.mockImplementation(async (name: string) => {
    if (name === "testSuites:listTestCases") return [];
    if (name === "testSuites:getTestSuite") {
      return { projectId: "project-1", environment: { servers: ["s1"] } };
    }
    return null;
  });
});

describe("eval launch server preflight", () => {
  it("refuses a disconnected server before the run is created", async () => {
    const failure = await launch(disconnected()).catch((error) => error);

    expect(failure).toBeInstanceOf(WebRouteError);
    expect(failure).toMatchObject({
      status: 409,
      code: "SERVER_UNREACHABLE",
      message:
        'Could not start eval because "Linear" is not connected. Reconnect the server and try again.',
    });
    expect(mocks.mutation).not.toHaveBeenCalled();
    expect(mocks.action).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalledWith(
      "testSuites:findSuiteRunByIdempotencyKey",
      expect.anything(),
    );
  });

  describe("a keyed retry", () => {
    const answerLookup = (answer: () => Promise<unknown>) => {
      const fallback = mocks.query.getMockImplementation()!;
      mocks.query.mockImplementation(async (name: string, args: unknown) =>
        name === "testSuites:findSuiteRunByIdempotencyKey"
          ? answer()
          : fallback(name, args),
      );
    };

    // Nothing answers the setup queries, so any setup gate that ran would
    // refuse and finalize the run as failed.
    const answerStart = (deduped: boolean) =>
      mocks.mutation.mockImplementation(async (name: string) =>
        name === "testSuites:startTestSuiteRun"
          ? { runId: "run-1", testCases: [], deduped, status: "running" }
          : null,
      );

    it("is handed its in-flight run without executing or failing it", async () => {
      answerLookup(async () => ({ runId: "run-1" }));
      answerStart(true);

      const prepared = await launch(disconnected(), {
        idempotencyKey: "trigger-1",
      });

      expect(mocks.query).toHaveBeenCalledWith(
        "testSuites:findSuiteRunByIdempotencyKey",
        { idempotencyKey: "trigger-1", suiteId: "suite-1" },
      );
      expect(mocks.mutation).toHaveBeenCalledWith(
        "testSuites:startTestSuiteRun",
        expect.objectContaining({
          suiteId: "suite-1",
          idempotencyKey: "trigger-1",
        }),
      );
      expect(prepared).toMatchObject({
        runId: "run-1",
        deduped: true,
        status: "running",
        serverUnreachable: true,
      });
      expect(shouldSkipExecution(prepared)).toBe(true);
      expect(mocks.mutation.mock.calls.map(([name]) => name)).toEqual([
        "testSuites:startTestSuiteRun",
      ]);
    });

    it("closes a run the start created instead and keeps the refusal", async () => {
      // The lookup found a run but the start did not dedupe into it, e.g.
      // because that run was deleted in between.
      answerLookup(async () => ({ runId: "run-0" }));
      answerStart(false);

      await expect(
        launch(disconnected(), { idempotencyKey: "trigger-1" }),
      ).rejects.toMatchObject({ status: 409, code: "SERVER_UNREACHABLE" });
      expect(mocks.mutation).toHaveBeenCalledWith(
        "testSuites:markSetupPendingIterationsFailed",
        expect.objectContaining({ runId: "run-1" }),
      );
    });

    it("is not executed by the inline runner either", async () => {
      answerLookup(async () => ({ runId: "run-1" }));
      answerStart(true);

      await expect(
        runEvalsWithManager(
          disconnected() as never,
          request({ idempotencyKey: "trigger-1" }),
        ),
      ).resolves.toMatchObject({ runId: "run-1" });
    });

    it("with no run under its key is still refused", async () => {
      answerLookup(async () => null);

      await expect(
        launch(disconnected(), { idempotencyKey: "trigger-1" }),
      ).rejects.toMatchObject({ status: 409, code: "SERVER_UNREACHABLE" });
      expect(mocks.mutation).not.toHaveBeenCalled();
    });

    it("is still refused when the backend has no lookup", async () => {
      answerLookup(async () => {
        throw new Error(
          "Could not find public function for 'testSuites:findSuiteRunByIdempotencyKey'",
        );
      });

      await expect(
        launch(disconnected(), { idempotencyKey: "trigger-1" }),
      ).rejects.toMatchObject({ status: 409, code: "SERVER_UNREACHABLE" });
      expect(mocks.mutation).not.toHaveBeenCalled();
    });
  });

  it("refuses a connected server whose tools cannot be listed", async () => {
    const failure = await launch(
      manager({
        listTools: async () => {
          throw new Error("tools/list timed out");
        },
        status: "connected",
      }),
    ).catch((error) => error);

    expect(failure).toMatchObject({
      status: 502,
      code: "SERVER_UNREACHABLE",
      message:
        'Could not start eval because "Linear" failed to list tools. Reconnect the server and try again.',
    });
    expect(mocks.mutation).not.toHaveBeenCalled();
    expect(mocks.action).not.toHaveBeenCalled();
  });

  it("still launches a benchmark cell against a disconnected target", async () => {
    await launch(disconnected(), {
      source: "benchmark",
      benchmarkRunId: "bench-1",
    }).catch(() => undefined);

    expect(mocks.mutation).toHaveBeenCalledWith(
      "testSuites:startTestSuiteRun",
      expect.objectContaining({ suiteId: "suite-1" }),
    );
  });
});
