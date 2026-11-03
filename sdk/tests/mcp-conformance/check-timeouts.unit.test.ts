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
      error: { message: "Skipped because the server stopped responding." },
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
        "Skipped because the server stopped responding."
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
