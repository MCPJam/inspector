import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProtocolError } from "@modelcontextprotocol/client";

/**
 * A served variant whose base changed an edited tool answers `tools/list` with
 * `VARIANT_BASE_DRIFTED`. A tool call would still reach the base, so the run
 * is refused with that code and the message naming the tools: at launch,
 * from the tool snapshot, and at discovery if the base changes after launch.
 */

const generateTextMock = vi.hoisted(() => vi.fn());
const streamTextMock = vi.hoisted(() => vi.fn());

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateText: (...args: unknown[]) => generateTextMock(...args),
    streamText: (...args: unknown[]) => streamTextMock(...args),
    stepCountIs: vi.fn(() => undefined),
  };
});
vi.mock("../../../utils/chat-helpers", async () => ({
  ...(await vi.importActual<typeof import("../../../utils/chat-helpers")>(
    "../../../utils/chat-helpers",
  )),
  createLlmModel: vi.fn(() => ({ id: "mock-model" })),
}));
vi.mock("../../../utils/pinned-fetch", () => ({
  createPinnedFetch: () => vi.fn(async () => ({ ok: true })),
}));

import {
  runEvalSuiteWithAiSdk,
  throwIfEvalToolSnapshotFailed,
} from "../../evals-runner";
import { exportConnectedServerToolSnapshotForEvalAuthoring } from "../../../utils/export-helpers";
import { mapErrorToV1 } from "../../../routes/v1/envelope";

const MESSAGE =
  "The base server changed tools this variant edits: show_servers. Create the variant again from the current server.";

function driftError() {
  return new ProtocolError(-32090, MESSAGE, {
    code: "VARIANT_BASE_DRIFTED",
    tools: ["show_servers"],
    variantId: "variant1",
  });
}

describe("a drifted variant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is refused at launch from the tool snapshot, ahead of a sibling's connect failure", async () => {
    const manager = {
      listTools: vi.fn(async (serverId: string) => {
        throw serverId === "v1" ? driftError() : new Error("not connected");
      }),
      getConnectionStatus: (serverId: string) =>
        serverId === "v1" ? "connected" : "disconnected",
    };
    const toolSnapshot = await exportConnectedServerToolSnapshotForEvalAuthoring(
      manager as never,
      ["s0", "v1"],
    );

    let refusal: unknown;
    try {
      throwIfEvalToolSnapshotFailed({
        toolSnapshot,
        mcpClientManager: manager as never,
        environment: undefined,
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({
      status: 409,
      code: "VARIANT_BASE_DRIFTED",
      message: MESSAGE,
      details: { serverId: "v1", tools: ["show_servers"], variantId: "variant1" },
    });
    // Publicly a CONFLICT that keeps the variant's code.
    expect(mapErrorToV1(refusal)).toMatchObject({
      code: "CONFLICT",
      message: MESSAGE,
      details: { code: "VARIANT_BASE_DRIFTED", tools: ["show_servers"] },
    });
  });

  it("stops the run at discovery instead of carrying on with no tools", async () => {
    const convexClient = { mutation: vi.fn(), query: vi.fn(), action: vi.fn() };
    convexClient.query.mockResolvedValue({ iterations: [] });
    const mcpClientManager = {
      getToolsForAiSdk: vi.fn().mockRejectedValue(driftError()),
      getConnectionStatus: vi.fn().mockReturnValue("connected"),
      getServerConfig: vi.fn().mockReturnValue(undefined),
      listServers: vi.fn().mockReturnValue(["v1"]),
      getAllToolsMetadata: vi.fn().mockReturnValue({}),
      executeTool: vi.fn(),
    };
    const recorder = {
      runId: "run-1",
      suiteId: "suite-1",
      startIteration: vi.fn(),
      finishIteration: vi.fn(),
      finalize: vi.fn(),
    };

    await expect(
      runEvalSuiteWithAiSdk({
        suiteId: "suite-1",
        runId: "run-1",
        recorder,
        config: {
          tests: [
            {
              title: "Case",
              query: "Hello",
              runs: 1,
              model: "gpt-4-turbo",
              provider: "openai",
              expectedToolCalls: [],
              promptTurns: [{ id: "turn-1", prompt: "Hello", expectedToolCalls: [] }],
              testCaseId: "case-1",
            },
          ],
          environment: { servers: ["v1"] },
        },
        modelApiKeys: { openai: "sk-test" },
        convexClient,
        convexHttpUrl: "https://example.convex.site",
        convexAuthToken: "token",
        mcpClientManager,
        testCaseId: "case-1",
      } as never),
    ).rejects.toMatchObject({ code: "VARIANT_BASE_DRIFTED", message: MESSAGE });

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(streamTextMock).not.toHaveBeenCalled();
    expect(recorder.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
  });
});
