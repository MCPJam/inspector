/**
 * A check the server does not answer in time could not run; it did not fail,
 * and the checks after it still get their turn until the server has clearly
 * stopped answering.
 */

import { isTimedOutCheck } from "../../src/conformance-timeout.js";
import { MCPConformanceTest } from "../../src/mcp-conformance/index.js";
import type { MCPCheckId } from "../../src/mcp-conformance/types.js";
import * as operations from "../../src/operations.js";

vi.mock("../../src/operations.js", () => ({
  listPrompts: vi.fn(),
  listResources: vi.fn(),
  listTools: vi.fn(),
  withEphemeralClient: vi.fn(),
}));

const mockedOperations = vi.mocked(operations);

/** The shape the MCP client raises when a request runs out of time. */
const requestTimeout = Object.assign(new Error("Request timed out"), {
  code: "REQUEST_TIMEOUT",
});

const never = () => new Promise<never>(() => {});

const SERVER_CONFIG = { url: "https://example.com/mcp" };

function serveManager(manager: Record<string, unknown>) {
  mockedOperations.withEphemeralClient.mockImplementation(async (_config, fn) =>
    fn(
      {
        getManagedClient: vi.fn().mockReturnValue({}),
        getInitializationInfo: vi.fn().mockReturnValue({
          protocolVersion: "2025-11-25",
        }),
        listResourceTemplates: vi.fn().mockResolvedValue({
          resourceTemplates: [],
        }),
        // A timed-out ping reconnects; by default the server accepts it.
        getServerConfig: vi.fn().mockReturnValue(SERVER_CONFIG),
        disconnectServer: vi.fn().mockResolvedValue(undefined),
        connectToServer: vi.fn().mockResolvedValue({}),
        ...manager,
      } as unknown as Parameters<typeof fn>[0],
      "server-1"
    )
  );
  mockedOperations.listTools.mockResolvedValue({ tools: [] });
  mockedOperations.listPrompts.mockResolvedValue({ prompts: [] });
  mockedOperations.listResources.mockResolvedValue({ resources: [] });
}

function run(checkIds: MCPCheckId[]) {
  return new MCPConformanceTest({
    serverUrl: "https://example.com/mcp",
    checkTimeout: 50,
    checkIds,
    readinessIds: [],
  }).run();
}

describe("protocol checks that run out of time", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("reports a timed-out check as could-not-run and runs the next one", async () => {
    serveManager({
      pingServer: vi.fn().mockRejectedValue(requestTimeout),
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
    });

    const result = await run(["ping", "tools-list"]);

    const ping = result.checks.find((check) => check.id === "ping");
    expect(ping).toMatchObject({
      status: "skipped",
      skipReason: "could-not-run",
      details: { timedOut: true, timeoutMs: 50 },
    });
    expect(ping?.error?.message).toMatch(/did not answer within 0\.1 seconds/);
    expect(
      result.checks.find((check) => check.id === "tools-list")
    ).toMatchObject({ status: "passed" });
    expect(result.outcome).toBe("incomplete");
  });

  it("stops a check whose request never settles at the check's limit", async () => {
    serveManager({
      pingServer: vi.fn().mockImplementation(never),
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
    });

    const result = await run(["ping", "tools-list"]);

    expect(isTimedOutCheck(result.checks[0]!)).toBe(true);
    expect(result.checks[1]).toMatchObject({ status: "passed" });
  });

  it("aborts the timed-out request before the next check starts", async () => {
    let activeSignal: AbortSignal | undefined;
    const listTools = vi.fn().mockImplementation(async () => {
      expect(activeSignal?.aborted).toBe(true);
      return { tools: [] };
    });
    serveManager({
      pingServer: vi.fn().mockImplementation((_id, options) => {
        activeSignal = options.signal;
        return new Promise(() => {});
      }),
      listTools,
    });

    const result = await run(["ping", "tools-list"]);

    expect(result.checks[0]?.details?.timedOut).toBe(true);
    expect(result.checks[1]?.status).toBe("passed");
    expect(listTools).toHaveBeenCalledTimes(1);
  });

  it("skips the rest once two checks in a row time out", async () => {
    const listTools = vi.fn().mockRejectedValue(requestTimeout);
    serveManager({
      pingServer: vi.fn().mockImplementation(never),
      listTools,
    });

    const result = await run([
      "ping",
      "tools-list",
      "tools-input-schemas-valid",
    ]);

    expect(result.checks.filter((check) => check.status === "failed")).toEqual(
      []
    );
    expect(result.checks.map(isTimedOutCheck)).toEqual([true, true, false]);
    expect(result.checks[2]).toMatchObject({
      status: "skipped",
      skipReason: "could-not-run",
      error: {
        message:
          'Skipped because the server stopped responding ("Ping" and "Tools List" timed out).',
      },
      details: { blockedBy: "ping" },
    });
    expect(listTools).toHaveBeenCalledTimes(1);
  });

  it.each(["passed", "failed"] as const)(
    "keeps counting across a %s check that only reads connection data",
    async (status) => {
      const listTools = vi.fn().mockRejectedValue(requestTimeout);
      serveManager({
        getInitializationInfo: vi.fn().mockReturnValue({
          protocolVersion: "2025-11-25",
          serverCapabilities: status === "passed" ? {} : undefined,
        }),
        pingServer: vi.fn().mockRejectedValue(requestTimeout),
        listTools,
      });

      const result = await run([
        "ping",
        "capabilities-consistent",
        "tools-list",
        "tools-input-schemas-valid",
      ]);

      expect(result.checks[1]).toMatchObject({
        id: "capabilities-consistent",
        status,
      });
      expect(result.checks.map(isTimedOutCheck)).toEqual([
        true,
        false,
        true,
        false,
      ]);
      expect(result.checks[3]?.error?.message).toBe(
        'Skipped because the server stopped responding ("Ping" and "Tools List" timed out).'
      );
      expect(listTools).toHaveBeenCalledTimes(1);
    }
  );

  it("resets the timeout count when a later request receives an answer", async () => {
    const listTools = vi
      .fn()
      .mockResolvedValueOnce({ tools: [] })
      .mockRejectedValueOnce(requestTimeout);
    const listPrompts = vi.fn().mockResolvedValue({ prompts: [] });
    serveManager({
      pingServer: vi.fn().mockRejectedValue(requestTimeout),
      listTools,
      listPrompts,
    });

    const result = await run([
      "ping",
      "tools-list",
      "tools-input-schemas-valid",
      "prompts-list",
    ]);

    expect(result.checks.map((check) => check.status)).toEqual([
      "skipped",
      "passed",
      "skipped",
      "passed",
    ]);
    expect(listTools).toHaveBeenCalledTimes(2);
    expect(listPrompts).toHaveBeenCalledTimes(1);
  });

  it("keeps counting across a check that skipped without asking the server", async () => {
    serveManager({
      pingServer: vi.fn().mockRejectedValue(requestTimeout),
      listTools: vi.fn().mockImplementation(never),
    });

    // No logging capability: logging-set-level is not applicable and sends
    // nothing, so it neither ends nor extends the streak.
    const result = await run([
      "ping",
      "logging-set-level",
      "tools-list",
      "tools-input-schemas-valid",
    ]);

    expect(result.checks.map((check) => check.skipReason)).toEqual([
      "could-not-run",
      "not-applicable",
      "could-not-run",
      "could-not-run",
    ]);
    expect(result.checks[3]?.error?.message).toMatch(
      /server stopped responding/
    );
  });

  it("still fails a check on an error that is not a timeout", async () => {
    serveManager({
      pingServer: vi.fn().mockRejectedValue(new Error("Method not found")),
    });

    const result = await run(["ping"]);

    expect(result.checks[0]).toMatchObject({ status: "failed" });
    expect(isTimedOutCheck(result.checks[0]!)).toBe(false);
  });
});

/**
 * "Timeouts SHOULD be treated as connection failures" (2025 revisions,
 * basic/utilities/ping.mdx): a ping with no answer ends the connection, and
 * the checks after it run on a new one.
 */
describe("a ping that runs out of time", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  const LOGGING = {
    protocolVersion: "2025-11-25",
    serverCapabilities: { logging: {} },
  };

  it.each([
    ["rejects with a timeout", () => Promise.reject(requestTimeout)],
    ["never settles", never],
  ])(
    "reconnects and runs the next check on the new connection when the ping %s",
    async (_name, ping) => {
      const firstClient = { setLoggingLevel: vi.fn() };
      const secondClient = {
        setLoggingLevel: vi.fn().mockResolvedValue(undefined),
      };
      const disconnectServer = vi.fn().mockResolvedValue(undefined);
      const connectToServer = vi.fn().mockResolvedValue(secondClient);
      serveManager({
        getManagedClient: vi.fn().mockReturnValue(firstClient),
        getInitializationInfo: vi.fn().mockReturnValue(LOGGING),
        pingServer: vi.fn().mockImplementation(ping),
        disconnectServer,
        connectToServer,
      });

      const result = await run(["ping", "logging-set-level"]);

      expect(result.checks[0]).toMatchObject({
        id: "ping",
        status: "skipped",
        skipReason: "could-not-run",
        details: { timedOut: true, reconnected: true },
      });
      expect(result.checks[0]?.error?.message).toMatch(
        /did not answer within .* ran on a new connection\.$/
      );
      expect(disconnectServer).toHaveBeenCalledExactlyOnceWith("server-1");
      expect(connectToServer).toHaveBeenCalledExactlyOnceWith(
        "server-1",
        SERVER_CONFIG,
        expect.anything()
      );
      expect(disconnectServer.mock.invocationCallOrder[0]).toBeLessThan(
        connectToServer.mock.invocationCallOrder[0]!
      );
      expect(result.checks[1]).toMatchObject({
        id: "logging-set-level",
        status: "passed",
      });
      expect(firstClient.setLoggingLevel).not.toHaveBeenCalled();
      expect(secondClient.setLoggingLevel).toHaveBeenCalledTimes(1);
    }
  );

  it("skips the remaining checks when the server does not accept a new connection", async () => {
    const listTools = vi.fn().mockResolvedValue({ tools: [] });
    serveManager({
      pingServer: vi.fn().mockRejectedValue(requestTimeout),
      connectToServer: vi.fn().mockRejectedValue(new Error("fetch failed")),
      listTools,
    });

    const result = await run(["ping", "tools-list"]);

    expect(result.checks[0]).toMatchObject({
      id: "ping",
      skipReason: "could-not-run",
      details: { timedOut: true, reconnected: false },
    });
    expect(result.checks[0]?.error?.message).not.toMatch(/new connection/);
    expect(result.checks[1]).toMatchObject({
      id: "tools-list",
      status: "skipped",
      skipReason: "could-not-run",
      error: {
        message:
          'Skipped because the server stopped responding ("Ping" timed out).',
      },
      details: { blockedBy: "ping" },
    });
    expect(result.checks.filter((check) => check.status === "failed")).toEqual(
      []
    );
    expect(listTools).not.toHaveBeenCalled();
  });

  it("keeps the connection when another check times out", async () => {
    const disconnectServer = vi.fn();
    const connectToServer = vi.fn();
    serveManager({
      pingServer: vi.fn().mockResolvedValue({}),
      listTools: vi.fn().mockRejectedValue(requestTimeout),
      listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
      disconnectServer,
      connectToServer,
    });

    const result = await run(["ping", "tools-list", "prompts-list"]);

    expect(result.checks.map((check) => check.status)).toEqual([
      "passed",
      "skipped",
      "passed",
    ]);
    expect(result.checks[1]?.details).toEqual({
      timedOut: true,
      timeoutMs: 50,
    });
    expect(disconnectServer).not.toHaveBeenCalled();
    expect(connectToServer).not.toHaveBeenCalled();
  });
});
