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

import { prepareEvalRun } from "../evals";
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

function launch(
  clientManager: ReturnType<typeof manager>,
  overrides: Record<string, unknown> = {},
) {
  return prepareEvalRun(
    clientManager as never,
    {
      suiteId: "suite-1",
      suiteRerun: true,
      serverIds: ["s1"],
      serverNames: ["Linear"],
      tests: [],
      convexAuthToken: "token",
      orgModelConfig: { providers: [] },
      ...overrides,
    } as never,
  );
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
