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
      listTools: vi.fn().mockRejectedValue(requestTimeout),
      listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
    });

    const result = await run(["tools-list", "prompts-list"]);

    const tools = result.checks.find((check) => check.id === "tools-list");
    expect(tools).toMatchObject({
      status: "skipped",
      skipReason: "could-not-run",
      details: { timedOut: true, timeoutMs: 50 },
    });
    expect(tools?.error?.message).toMatch(/did not answer within 0\.1 seconds/);
    expect(
      result.checks.find((check) => check.id === "prompts-list")
    ).toMatchObject({ status: "passed" });
    expect(result.outcome).toBe("incomplete");
  });

  it("stops a check whose request never settles at the check's limit", async () => {
    serveManager({
      listTools: vi.fn().mockImplementation(never),
      listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
    });

    const result = await run(["tools-list", "prompts-list"]);

    expect(isTimedOutCheck(result.checks[0]!)).toBe(true);
    expect(result.checks[1]).toMatchObject({ status: "passed" });
  });

  it("aborts the timed-out request before the next check starts", async () => {
    let activeSignal: AbortSignal | undefined;
    const listPrompts = vi.fn().mockImplementation(async () => {
      expect(activeSignal?.aborted).toBe(true);
      return { prompts: [] };
    });
    serveManager({
      listTools: vi.fn().mockImplementation((_id, _params, options) => {
        activeSignal = options.signal;
        return new Promise(() => {});
      }),
      listPrompts,
    });

    const result = await run(["tools-list", "prompts-list"]);

    expect(result.checks[0]?.details?.timedOut).toBe(true);
    expect(result.checks[1]?.status).toBe("passed");
    expect(listPrompts).toHaveBeenCalledTimes(1);
  });

  it("skips the rest once two checks in a row time out", async () => {
    const listPrompts = vi.fn().mockRejectedValue(requestTimeout);
    const listResources = vi.fn().mockResolvedValue({ resources: [] });
    serveManager({
      listTools: vi.fn().mockImplementation(never),
      listPrompts,
      listResources,
    });

    const result = await run(["tools-list", "prompts-list", "resources-list"]);

    expect(result.checks.filter((check) => check.status === "failed")).toEqual(
      []
    );
    expect(result.checks.map(isTimedOutCheck)).toEqual([true, true, false]);
    expect(result.checks[2]).toMatchObject({
      status: "skipped",
      skipReason: "could-not-run",
      error: {
        message:
          'Skipped because the server stopped responding ("Tools List" and "Prompts List" timed out).',
      },
      details: { blockedBy: "tools-list" },
    });
    expect(listPrompts).toHaveBeenCalledTimes(1);
    expect(listResources).not.toHaveBeenCalled();
  });

  it.each(["passed", "failed"] as const)(
    "keeps counting across a %s check that only reads connection data",
    async (status) => {
      const listTools = vi.fn().mockRejectedValue(requestTimeout);
      serveManager({
        getManagedClient: vi.fn().mockReturnValue({
          setLoggingLevel: vi.fn().mockRejectedValue(requestTimeout),
        }),
        getInitializationInfo: vi.fn().mockReturnValue({
          protocolVersion: "2025-11-25",
          serverCapabilities: { logging: {} },
        }),
        listTools,
      });
      if (status === "failed") {
        // A listed tool with no `tools` capability is a mismatch.
        mockedOperations.listTools.mockResolvedValue({
          tools: [{ name: "echo", inputSchema: { type: "object" } }],
        } as never);
      }

      const result = await run([
        "logging-set-level",
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
        'Skipped because the server stopped responding ("Logging Set Level" and "Tools List" timed out).'
      );
      expect(listTools).toHaveBeenCalledTimes(1);
    }
  );

  it("resets the timeout count when a later request receives an answer", async () => {
    const listTools = vi
      .fn()
      .mockRejectedValueOnce(requestTimeout)
      .mockResolvedValueOnce({ tools: [] });
    const listPrompts = vi.fn().mockRejectedValue(requestTimeout);
    const listResources = vi.fn().mockResolvedValue({ resources: [] });
    serveManager({ listTools, listPrompts, listResources });

    const result = await run([
      "tools-list",
      "tools-input-schemas-valid",
      "prompts-list",
      "resources-list",
    ]);

    expect(result.checks.map((check) => check.status)).toEqual([
      "skipped",
      "passed",
      "skipped",
      "passed",
    ]);
    expect(listTools).toHaveBeenCalledTimes(2);
    expect(listResources).toHaveBeenCalledTimes(1);
  });

  it("keeps counting across a check that skipped without asking the server", async () => {
    serveManager({
      getManagedClient: vi.fn().mockReturnValue({
        setLoggingLevel: vi.fn().mockRejectedValue(requestTimeout),
      }),
      getInitializationInfo: vi.fn().mockReturnValue({
        protocolVersion: "2025-11-25",
        serverCapabilities: { logging: {} },
      }),
      listTools: vi.fn().mockImplementation(never),
    });

    // No completions capability: completion-complete is not applicable and
    // sends nothing, so it neither ends nor extends the streak.
    const result = await run([
      "logging-set-level",
      "completion-complete",
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
 * basic/utilities/ping.mdx): a ping with no answer means the connection is
 * lost, so the checks after it are skipped.
 */
describe("a ping that runs out of time", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it.each([
    ["rejects with a timeout", () => Promise.reject(requestTimeout)],
    ["never settles", never],
  ])("skips the checks after it when the ping %s", async (_name, ping) => {
    const listTools = vi.fn().mockResolvedValue({ tools: [] });
    const listPrompts = vi.fn().mockResolvedValue({ prompts: [] });
    serveManager({
      pingServer: vi.fn().mockImplementation(ping),
      listTools,
      listPrompts,
    });

    const result = await run(["ping", "tools-list", "prompts-list"]);

    expect(result.checks[0]).toMatchObject({
      id: "ping",
      status: "skipped",
      skipReason: "could-not-run",
      details: { timedOut: true, connectionLost: true },
    });
    expect(result.checks[0]?.error?.message).toMatch(
      /did not answer within .* the checks after this one were skipped\.$/
    );
    for (const check of result.checks.slice(1)) {
      expect(check).toMatchObject({
        status: "skipped",
        skipReason: "could-not-run",
        error: {
          message:
            'Skipped because the server stopped responding ("Ping" timed out).',
        },
        details: { blockedBy: "ping" },
      });
    }
    expect(result.checks.filter((check) => check.status === "failed")).toEqual(
      []
    );
    expect(listTools).not.toHaveBeenCalled();
    expect(listPrompts).not.toHaveBeenCalled();
  });

  it("keeps the session when another check times out", async () => {
    serveManager({
      pingServer: vi.fn().mockResolvedValue({}),
      listTools: vi.fn().mockRejectedValue(requestTimeout),
      listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
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
  });
});
