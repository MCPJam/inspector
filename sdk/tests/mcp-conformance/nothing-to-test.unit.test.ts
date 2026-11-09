/**
 * "Nothing to test" is gray only when the run really read the lists, and a
 * check blocked by a failed connect names the check that carries it.
 */

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

function serveManager(manager: Record<string, unknown>) {
  mockedOperations.withEphemeralClient.mockImplementation(async (_config, fn) =>
    fn(
      {
        getManagedClient: vi.fn().mockReturnValue({}),
        getInitializationInfo: vi.fn().mockReturnValue({
          protocolVersion: "2025-11-25",
          serverCapabilities: { completions: {}, prompts: {} },
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
    protocolVersion: "2025-11-25",
    checkTimeout: 1_000,
    checkIds,
    readinessIds: [],
  }).run();
}

describe("completion with nothing to complete", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("is not applicable when the server has no prompts or templates", async () => {
    serveManager({});
    const result = await run(["completion-complete"]);
    expect(result.checks[0]).toMatchObject({
      id: "completion-complete",
      status: "skipped",
      skipReason: "not-applicable",
      error: {
        message:
          "The server has no prompts or resource templates, so there is nothing to complete.",
      },
    });
  });

  it("stays untested when the prompt list could not be read", async () => {
    serveManager({});
    mockedOperations.listPrompts.mockRejectedValue(new Error("boom"));
    const result = await run(["completion-complete"]);
    expect(result.checks[0]).toMatchObject({
      id: "completion-complete",
      status: "skipped",
      skipReason: "could-not-run",
    });
  });
});

describe("a failed connect", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("is named by every check it blocked", async () => {
    mockedOperations.withEphemeralClient.mockRejectedValue(
      new Error("connect ECONNREFUSED")
    );
    const result = await run(["server-initialize", "ping"]);
    const initialize = result.checks.find((c) => c.id === "server-initialize")!;
    const ping = result.checks.find((c) => c.id === "ping")!;
    expect(initialize.status).toBe("failed");
    expect(ping).toMatchObject({
      status: "skipped",
      skipReason: "could-not-run",
      error: { message: `Skipped because "${initialize.title}" failed first.` },
      details: { blockedBy: "server-initialize" },
    });
  });
});
