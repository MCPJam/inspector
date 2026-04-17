import { describe, expect, it, vi } from "vitest";
import {
  createEphemeralRunRecorder,
  startSuiteRunWithRecorder,
} from "../recorder.js";

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

describe("createEphemeralRunRecorder", () => {
  it("stores inline trace payloads with router-safe guest ids", async () => {
    const recorder = createEphemeralRunRecorder();
    const startedAt = 1_234;

    expect(recorder.runId).toMatch(/^guestrun-[A-Za-z0-9_-]+$/);
    expect(recorder.suiteId).toMatch(/^guestsuite-[A-Za-z0-9_-]+$/);

    const iterationId = await recorder.startIteration({
      testCaseId: "guestcase-1",
      testCaseSnapshot: {
        title: "Guest run",
        query: "hello",
        provider: "openai",
        model: "gpt-4",
        expectedToolCalls: [],
      },
      iterationNumber: 1,
      startedAt,
    });

    expect(iterationId).toMatch(/^guestiter-[A-Za-z0-9_-]+$/);

    await recorder.finishIteration({
      iterationId,
      passed: false,
      toolsCalled: [{ toolName: "search", arguments: { q: "hello" } }],
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      spans: [
        {
          id: "step-1",
          name: "Search",
          category: "step",
          startMs: 0,
          endMs: 1,
        },
      ],
      prompts: [
        {
          promptIndex: 0,
          prompt: "hello",
          expectedToolCalls: [],
          actualToolCalls: [{ toolName: "search", arguments: { q: "hello" } }],
          passed: false,
          missing: [],
          unexpected: [],
          argumentMismatches: [],
        },
      ],
      resultSource: "derived",
      metadata: { compareRunId: "cmp_guest_1" },
      error: "No answer",
    });

    expect(recorder.getIterations()).toEqual([
      expect.objectContaining({
        _id: iterationId,
        testCaseId: "guestcase-1",
        startedAt,
        status: "failed",
        result: "failed",
        tokensUsed: 15,
        actualToolCalls: [{ toolName: "search", arguments: { q: "hello" } }],
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
        ],
        spans: [
          expect.objectContaining({
            id: "step-1",
            name: "Search",
          }),
        ],
        prompts: [
          expect.objectContaining({
            prompt: "hello",
            passed: false,
          }),
        ],
        metadata: { compareRunId: "cmp_guest_1" },
        error: "No answer",
      }),
    ]);
  });
});
