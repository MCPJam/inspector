import { describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import {
  createSuiteRunRecorder,
  startSuiteRunWithRecorder,
} from "../recorder.js";

describe("startSuiteRunWithRecorder", () => {
  it("forwards per-run import approvals, and omits the key when there are none", async () => {
    // The mutation args are RECONSTRUCTED field by field in this function, so
    // a field nobody names here never reaches Convex — and an approval that
    // never arrives surfaces to the caller as the backend refusing a run they
    // did approve. Asserting the exact args is the only thing that catches it.
    const mutation = vi.fn().mockResolvedValue({ runId: "run-1", testCases: [] });
    const convexClient = { mutation } as any;
    const importApprovals = [
      { testCaseId: "tc-1", reason: "Reviewed against the upstream rubric." },
    ];

    await startSuiteRunWithRecorder({
      convexClient,
      suiteId: "suite-1",
      serverIds: ["alpha"],
      importApprovals,
    });
    expect(mutation.mock.calls[0][1]).toMatchObject({ importApprovals });

    mutation.mockClear();
    await startSuiteRunWithRecorder({
      convexClient,
      suiteId: "suite-1",
      serverIds: ["alpha"],
    });
    // Absent rather than `[]`: an empty array is a claim ("I approved
    // nothing"), and the backend reads the two differently.
    expect("importApprovals" in mutation.mock.calls[0][1]).toBe(false);
  });

  it("forwards the benchmark parent id that licenses the hidden source", async () => {
    // Same reconstruction hazard as the approvals above, with a sharper edge:
    // `startTestSuiteRun` refuses `source: 'benchmark'` unless it also receives
    // the `benchmarkRunId` of a live parent run (mcpjam-backend#1160). A field
    // nobody names here never reaches Convex, and dropping THIS one fails every
    // benchmark child at the mutation.
    const mutation = vi
      .fn()
      .mockResolvedValue({ runId: "run-1", testCases: [] });
    const convexClient = { mutation } as any;

    await startSuiteRunWithRecorder({
      convexClient,
      suiteId: "suite-1",
      serverIds: ["alpha"],
      source: "benchmark",
      benchmarkRunId: "brun-1",
    });
    expect(mutation.mock.calls[0][1]).toMatchObject({
      source: "benchmark",
      benchmarkRunId: "brun-1",
    });

    mutation.mockClear();
    await startSuiteRunWithRecorder({
      convexClient,
      suiteId: "suite-1",
      serverIds: ["alpha"],
      source: "api",
    });
    // Meaningless without the hidden source, so it is absent rather than
    // `undefined` — the mutation takes an id, not a placeholder.
    expect("benchmarkRunId" in mutation.mock.calls[0][1]).toBe(false);
  });

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
            steps: [
              {
                id: "s1",
                kind: "prompt",
                prompt: "Search for yesterday's tasks",
              },
            ],
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
      })
    );
    expect(mutationMock).toHaveBeenNthCalledWith(
      2,
      "testSuites:precreateIterationsForRun",
      { runId: "run-1" }
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
              steps: [
                {
                  id: "s1",
                  kind: "prompt",
                  prompt: "Search for yesterday's tasks",
                },
              ],
              advancedConfig: undefined,
              testCaseId: "tc-1",
            },
          ],
          environment: {
            servers: ["alpha"],
          },
        },
      })
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

  it("forwards all three environment preconditions to the start mutation", async () => {
    // The revision alone does not make an environment launch atomic: the env
    // pins a hostId (not a config) and optionally an attachment, both
    // dereferenced live, so a host rotation or server-group edit drifts the
    // resolution at an UNCHANGED revision. All three echoes must reach Convex
    // or that drift is undetectable.
    const mutationMock = vi
      .fn()
      .mockResolvedValueOnce({ runId: "run-1", testCases: [] })
      .mockResolvedValueOnce(undefined);

    await startSuiteRunWithRecorder({
      convexClient: { mutation: mutationMock } as any,
      suiteId: "suite-1",
      serverIds: ["ps_1", "ps_plugin"],
      environmentId: "env-1",
      expectedEnvironmentRevision: 4,
      expectedEnvironmentHostConfigId: "hc_1",
      expectedEnvironmentServerIds: ["ps_1", "ps_plugin"],
    });

    expect(mutationMock).toHaveBeenNthCalledWith(
      1,
      "testSuites:startTestSuiteRun",
      expect.objectContaining({
        environmentId: "env-1",
        expectedEnvironmentRevision: 4,
        expectedEnvironmentHostConfigId: "hc_1",
        expectedEnvironmentServerIds: ["ps_1", "ps_plugin"],
      })
    );
  });

  it("omits the environment preconditions entirely for a non-environment run", async () => {
    const mutationMock = vi
      .fn()
      .mockResolvedValueOnce({ runId: "run-1", testCases: [] })
      .mockResolvedValueOnce(undefined);

    await startSuiteRunWithRecorder({
      convexClient: { mutation: mutationMock } as any,
      suiteId: "suite-1",
      serverIds: ["alpha"],
    });

    const args = mutationMock.mock.calls[0][1];
    expect(args).not.toHaveProperty("environmentId");
    expect(args).not.toHaveProperty("expectedEnvironmentRevision");
    expect(args).not.toHaveProperty("expectedEnvironmentHostConfigId");
    expect(args).not.toHaveProperty("expectedEnvironmentServerIds");
  });

  it("translates a host-drift rejection into the 409 that names the cause", async () => {
    const { ConvexError } = await import("convex/values");
    const mutationMock = vi
      .fn()
      .mockRejectedValueOnce(new ConvexError({ code: "ENV_HOST_DRIFT" }));

    await expect(
      startSuiteRunWithRecorder({
        convexClient: { mutation: mutationMock } as any,
        suiteId: "suite-1",
        serverIds: ["ps_1"],
        environmentId: "env-1",
        expectedEnvironmentRevision: 4,
        expectedEnvironmentHostConfigId: "hc_1",
        expectedEnvironmentServerIds: ["ps_1"],
      })
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/host or server group changed/i),
    });
  });

  it("translates a revision conflict even when only the drift echoes were sent", async () => {
    // The gate is "any echo present", not "revision present" — a launch that
    // echoed only host config / servers still needs its conflict translated
    // rather than surfacing as a raw 500.
    const { ConvexError } = await import("convex/values");
    const mutationMock = vi
      .fn()
      .mockRejectedValueOnce(
        new ConvexError({ code: "ENV_REVISION_CONFLICT" })
      );

    await expect(
      startSuiteRunWithRecorder({
        convexClient: { mutation: mutationMock } as any,
        suiteId: "suite-1",
        serverIds: ["ps_1"],
        environmentId: "env-1",
        expectedEnvironmentHostConfigId: "hc_1",
      })
    ).rejects.toMatchObject({ status: 409 });
  });

  it("translates ENV_MODEL_REQUIRED into a branchable 409, with no echoes sent", async () => {
    // The backend refuses a headless launch whose environment resolves to no
    // model. Untranslated it reaches the caller as a bare Convex rejection —
    // reading as an internal fault rather than the one-field misconfiguration
    // it is. NOT gated on the drift echoes: this refusal is a property of the
    // environment itself, not of a precondition we sent.
    const { ConvexError } = await import("convex/values");
    const mutationMock = vi.fn().mockRejectedValueOnce(
      new ConvexError({
        code: "ENV_MODEL_REQUIRED",
        message: 'Environment "Prod" has no model to run.',
        details: { environmentId: "env-1", hostId: "h1" },
      })
    );

    await expect(
      startSuiteRunWithRecorder({
        convexClient: { mutation: mutationMock } as any,
        suiteId: "suite-1",
        serverIds: ["ps_1"],
        environmentId: "env-1",
      })
    ).rejects.toMatchObject({
      status: 409,
      message: 'Environment "Prod" has no model to run.',
      details: {
        code: "ENV_MODEL_REQUIRED",
        environmentId: "env-1",
        // The same slug the v1 environments resolve route emits, so a caller
        // branching on `details.reason` gets one answer from either surface.
        reason: "environment_model_required",
      },
    });
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
      })
    ).rejects.toThrow(
      "Could not start eval because MCPJam failed to prepare the test attempts. Try again."
    );

    expect(mutationMock).toHaveBeenNthCalledWith(
      2,
      "testSuites:precreateIterationsForRun",
      { runId: "run-1" }
    );
    expect(mutationMock).toHaveBeenNthCalledWith(
      3,
      "testSuites:markSetupPendingIterationsFailed",
      { runId: "run-1", error: "validation exploded" }
    );
    expect(mutationMock).toHaveBeenNthCalledWith(
      4,
      "testSuites:updateTestSuiteRun",
      {
        runId: "run-1",
        status: "failed",
        summary: undefined,
        notes: "Failed to prepare eval test attempts.",
      }
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
      status: "completed",
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
