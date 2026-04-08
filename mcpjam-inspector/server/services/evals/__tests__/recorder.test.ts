import { describe, expect, it, vi } from "vitest";
import { startSuiteRunWithRecorder } from "../recorder.js";

describe("startSuiteRunWithRecorder", () => {
  it("forwards tool snapshot metadata when creating a suite run", async () => {
    const mutationMock = vi
      .fn()
      .mockResolvedValueOnce({
        runId: "run-1",
        testCases: [
          {
            _id: "tc-1",
            title: "Bootstrap search",
            query: "Search for yesterday's tasks",
            model: "gpt-5",
            provider: "openai",
            runs: 1,
            expectedToolCalls: [
              {
                toolName: "bootstrap",
                arguments: {},
              },
            ],
          },
        ],
      })
      .mockResolvedValueOnce(undefined);

    const convexClient = {
      mutation: mutationMock,
    } as any;

    const toolSnapshot = {
      version: 1,
      capturedAt: 123,
      servers: [
        {
          serverId: "alpha",
          tools: [
            {
              name: "bootstrap",
              description: "Call this before using search.",
              inputSchema: {
                type: "object",
                $schema: "https://json-schema.org/draft/2020-12/schema",
              },
            },
          ],
        },
      ],
    };
    const toolSnapshotDebug = {
      captureResult: {
        status: "complete",
        serverCount: 1,
        toolCount: 1,
        failedServerCount: 0,
        failedServerIds: [],
      },
      promptSection: "# Available MCP Tools",
      promptSectionTruncated: false,
      promptSectionMaxChars: 30000,
      fallbackReason: null,
      fullSnapshot: toolSnapshot,
    };
    const sanitizedToolSnapshot = {
      version: 1,
      capturedAt: 123,
      servers: [
        {
          serverId: "alpha",
          tools: [
            {
              name: "bootstrap",
              description: "Call this before using search.",
              inputSchema: {
                type: "object",
                __convexReserved__schema:
                  "https://json-schema.org/draft/2020-12/schema",
              },
            },
          ],
        },
      ],
    };
    const sanitizedToolSnapshotDebug = {
      captureResult: {
        status: "complete",
        serverCount: 1,
        toolCount: 1,
        failedServerCount: 0,
        failedServerIds: [],
      },
      promptSection: "# Available MCP Tools",
      promptSectionTruncated: false,
      promptSectionMaxChars: 30000,
      fallbackReason: null,
      fullSnapshot: sanitizedToolSnapshot,
    };

    const result = await startSuiteRunWithRecorder({
      convexClient,
      suiteId: "suite-1",
      serverIds: ["alpha"],
      toolSnapshot,
      toolSnapshotDebug,
    });

    expect(mutationMock).toHaveBeenNthCalledWith(
      1,
      "testSuites:startTestSuiteRun",
      expect.objectContaining({
        suiteId: "suite-1",
        toolSnapshot: sanitizedToolSnapshot,
        toolSnapshotDebug: sanitizedToolSnapshotDebug,
      }),
    );
    expect(mutationMock).toHaveBeenNthCalledWith(
      2,
      "testSuites:precreateIterationsForRun",
      { runId: "run-1" },
    );
    expect(result).toEqual(
      expect.objectContaining({
        runId: "run-1",
        suiteId: "suite-1",
        config: {
          tests: [
            {
              title: "Bootstrap search",
              query: "Search for yesterday's tasks",
              model: "gpt-5",
              provider: "openai",
              runs: 1,
              expectedToolCalls: [
                {
                  toolName: "bootstrap",
                  arguments: {},
                },
              ],
              isNegativeTest: undefined,
              expectedOutput: undefined,
              promptTurns: undefined,
              advancedConfig: undefined,
              testCaseId: "tc-1",
            },
          ],
          environment: {
            servers: ["alpha"],
          },
        },
      }),
    );
  });
});
