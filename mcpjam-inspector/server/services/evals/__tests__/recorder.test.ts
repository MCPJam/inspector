import { describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import { createSuiteRunRecorder, startSuiteRunWithRecorder } from "../recorder.js";

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

  it("runs against the environment Convex snapshotted for the suite run", async () => {
    const snapshotEnvironment = {
      servers: ["friendly-server-name"],
      serverBindings: [
        {
          serverName: "friendly-server-name",
          projectServerId: "project-server-id",
        },
      ],
    };
    const mutationMock = vi
      .fn()
      .mockResolvedValueOnce({
        runId: "run-1",
        configSnapshot: {
          environment: snapshotEnvironment,
        },
        testCases: [
          {
            _id: "tc-1",
            title: "Snapshot server",
            query: "Use the pinned server",
            model: "gpt-5",
            provider: "openai",
            runs: 1,
            expectedToolCalls: [],
          },
        ],
      })
      .mockResolvedValueOnce(undefined);

    const result = await startSuiteRunWithRecorder({
      convexClient: { mutation: mutationMock } as any,
      suiteId: "suite-1",
      serverIds: ["request-server"],
    });

    expect(result.config.environment).toEqual(snapshotEnvironment);
  });

  it("marks the suite run failed when iteration precreate fails", async () => {
    const mutationMock = vi
      .fn()
      .mockResolvedValueOnce({
        runId: "run-1",
        testCases: [
          {
            _id: "tc-1",
            title: "Broken setup",
            query: "Try setup",
            model: "gpt-5",
            provider: "openai",
            runs: 1,
            expectedToolCalls: [],
          },
        ],
      })
      .mockRejectedValueOnce(new Error("validation exploded"))
      .mockResolvedValueOnce(undefined);

    await expect(
      startSuiteRunWithRecorder({
        convexClient: { mutation: mutationMock } as any,
        suiteId: "suite-1",
        serverIds: ["alpha"],
      }),
    ).rejects.toThrow(
      "Could not start eval because MCPJam failed to prepare the test attempts. Try again.",
    );

    expect(mutationMock).toHaveBeenNthCalledWith(
      2,
      "testSuites:precreateIterationsForRun",
      { runId: "run-1" },
    );
    expect(mutationMock).toHaveBeenNthCalledWith(
      3,
      "testSuites:markSetupPendingIterationsFailed",
      { runId: "run-1", error: "validation exploded" },
    );
    expect(mutationMock).toHaveBeenNthCalledWith(
      4,
      "testSuites:updateTestSuiteRun",
      {
        runId: "run-1",
        status: "failed",
        summary: undefined,
        notes: "Failed to prepare eval test attempts.",
      },
    );
  });

  it("surfaces eval iteration quota failures instead of the generic precreate error", async () => {
    const billingError = new Error(
      `Uncaught ConvexError: ${JSON.stringify({
        code: "billing_limit_reached",
        message:
          'Limit "maxEvalIterationsPerMonth" reached on the free plan.',
        limit: "maxEvalIterationsPerMonth",
        gateKey: "maxEvalIterationsPerMonth",
        plan: "free",
        currentValue: 31,
        allowedValue: 25,
        resetsAt: Date.UTC(2026, 5, 19, 17, 0),
        windowKind: "day",
      })}`,
    );
    const mutationMock = vi
      .fn()
      .mockResolvedValueOnce({
        runId: "run-1",
        testCases: [
          {
            _id: "tc-1",
            title: "Quota setup",
            query: "Try setup",
            model: "gpt-5",
            provider: "openai",
            runs: 1,
            expectedToolCalls: [],
          },
        ],
      })
      .mockRejectedValueOnce(billingError)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    await expect(
      startSuiteRunWithRecorder({
        convexClient: { mutation: mutationMock } as any,
        suiteId: "suite-1",
        serverIds: ["alpha"],
      }),
    ).rejects.toThrow(
      /^This organization has reached its eval iteration limit \(25\)\. Resets /,
    );

    expect(mutationMock).toHaveBeenNthCalledWith(
      4,
      "testSuites:updateTestSuiteRun",
      {
        runId: "run-1",
        status: "failed",
        summary: undefined,
        notes: expect.stringMatching(
          /^This organization has reached its eval iteration limit \(25\)\. Resets /,
        ),
        stopReason: undefined,
      },
    );
  });
});

describe("createSuiteRunRecorder", () => {
  it("flips runDeleted when finishIteration's shared finalize sees 'not found', short-circuiting subsequent startIteration", async () => {
    // Pre-check getTestIteration returns running; updateTestIteration throws
    // "not found" → shared finalizeEvalIteration fires `onRunDeleted` →
    // recorder's `runDeleted` flag flips → next `startIteration` no-ops
    // without ever querying Convex.
    const query = vi.fn(async (ref: string) => {
      if (ref === "testSuites:getTestIteration") {
        return { status: "running" };
      }
      throw new Error(`unexpected query ${ref}`);
    });
    const action = vi.fn(async (ref: string) => {
      if (ref === "testSuites:appendEvalTurnTrace") {
        return { skipped: false };
      }
      if (ref === "testSuites:updateTestIteration") {
        throw new Error("iteration not found");
      }
      if (ref === "testSuites:lockEvalSession") {
        return { skipped: false, locked: true, alreadyLocked: false };
      }
      throw new Error(`unexpected action ${ref}`);
    });
    const mutation = vi.fn();
    const convexClient = { query, action, mutation } as any;

    const recorder = createSuiteRunRecorder({
      convexClient,
      suiteId: "suite-1",
      runId: "run-1",
    });

    await recorder.finishIteration({
      iterationId: "iter1",
      passed: true,
      toolsCalled: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      messages: [{ role: "user", content: "hi" } as ModelMessage],
    });

    // The action threw "not found"; the runDeleted callback should have
    // fired. Confirm by calling startIteration and asserting it
    // short-circuits (no Convex calls).
    const queryCallsBefore = query.mock.calls.length;
    const mutationCallsBefore = mutation.mock.calls.length;
    const result = await recorder.startIteration({
      testCaseId: "tc1",
      iterationNumber: 1,
      startedAt: Date.now(),
    });
    expect(result).toBeUndefined();
    expect(query.mock.calls.length).toBe(queryCallsBefore);
    expect(mutation.mock.calls.length).toBe(mutationCallsBefore);
  });
});
