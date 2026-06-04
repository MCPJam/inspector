/**
 * Tests for the durable synthesis pump (plan v4 §F).
 *
 * The pump is a long-running loop, so the unit-level coverage here
 * exercises:
 *   - mode gating via `SYNTHESIS_RUNNER_MODE`
 *   - workerScope derivation per hosted/local
 *   - claim → runOneJob → complete path with stubs
 *   - error classification: lease-lost → silent, 501 refresh
 *     unavailable → `failJob('refresh_unavailable')`, else
 *     `failJob('execution_error')`
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionAgentMocks = vi.hoisted(() => ({
  claimJob: vi.fn(),
  heartbeatJob: vi.fn(),
  completeJob: vi.fn(),
  failJob: vi.fn(),
  personaNextTurnWorker: vi.fn(),
}));

const ingestionMocks = vi.hoisted(() => ({
  persistChatSessionToConvex: vi.fn(),
}));

const orchestrationMocks = vi.hoisted(() => ({
  prepareChatV2: vi.fn(),
}));

const assistantTurnMocks = vi.hoisted(() => ({
  runAssistantTurn: vi.fn(),
}));

const managerBuildMocks = vi.hoisted(() => ({
  buildSynthesisManager: vi.fn(),
}));

vi.mock("../../session-agent", async () => {
  const actual = await vi.importActual<typeof import("../../session-agent")>(
    "../../session-agent",
  );
  return {
    ...actual,
    claimJob: sessionAgentMocks.claimJob,
    heartbeatJob: sessionAgentMocks.heartbeatJob,
    completeJob: sessionAgentMocks.completeJob,
    failJob: sessionAgentMocks.failJob,
    personaNextTurnWorker: sessionAgentMocks.personaNextTurnWorker,
  };
});

vi.mock("../../../utils/chat-ingestion", () => ({
  persistChatSessionToConvex: ingestionMocks.persistChatSessionToConvex,
}));

vi.mock("../../../utils/chat-v2-orchestration", () => ({
  prepareChatV2: orchestrationMocks.prepareChatV2,
}));

vi.mock("../../../utils/assistant-turn", () => ({
  runAssistantTurn: assistantTurnMocks.runAssistantTurn,
}));

vi.mock("../../../utils/synthesis-manager-build", () => ({
  buildSynthesisManager: managerBuildMocks.buildSynthesisManager,
}));

vi.mock("@/shared/types", () => ({
  getModelById: vi.fn(() => ({ id: "openai/gpt-oss-120b", name: "gpt" })),
}));

import {
  getRunnerMode,
  __setFetchRunSnapshotForTesting,
  __internals,
  type DurableRunSnapshot,
} from "../durable-runner";

import {
  SessionWorkerLeaseLostError,
  SessionWorkerRefreshUnavailableError,
} from "../../session-agent";

beforeEach(() => {
  process.env.INSPECTOR_SERVICE_TOKEN = "tok";
  for (const fn of Object.values(sessionAgentMocks)) fn.mockReset();
  for (const fn of Object.values(ingestionMocks)) fn.mockReset();
  for (const fn of Object.values(orchestrationMocks)) fn.mockReset();
  for (const fn of Object.values(assistantTurnMocks)) fn.mockReset();
  for (const fn of Object.values(managerBuildMocks)) fn.mockReset();

  managerBuildMocks.buildSynthesisManager.mockReturnValue({
    manager: { disconnectAllServers: vi.fn() },
    connectedServerIds: ["srv-1"],
    dispose: vi.fn(async () => {}),
  });
  orchestrationMocks.prepareChatV2.mockResolvedValue({
    enhancedSystemPrompt: "sp",
    resolvedTemperature: 0.7,
    allTools: {},
    progressivePlan: undefined,
    discoveryState: undefined,
  });
  assistantTurnMocks.runAssistantTurn.mockResolvedValue({
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello back" },
    ],
    assistantMessages: [],
    toolCalls: [],
    toolResults: [],
  });
});

afterEach(() => {
  delete process.env.INSPECTOR_SERVICE_TOKEN;
  delete process.env.SYNTHESIS_RUNNER_MODE;
  delete process.env.HOSTED_MODE;
});

describe("getRunnerMode", () => {
  it("defaults to in_process", () => {
    delete process.env.SYNTHESIS_RUNNER_MODE;
    expect(getRunnerMode()).toBe("in_process");
  });
  it("returns durable when env literal is set", () => {
    process.env.SYNTHESIS_RUNNER_MODE = "durable";
    expect(getRunnerMode()).toBe("durable");
  });
  it("any other env value falls back to in_process", () => {
    process.env.SYNTHESIS_RUNNER_MODE = "other";
    expect(getRunnerMode()).toBe("in_process");
  });
});

describe("deriveWorkerScope", () => {
  it("returns 'any' in hosted mode", () => {
    process.env.HOSTED_MODE = "true";
    expect(__internals.deriveWorkerScope()).toBe("any");
  });
  it("returns local:<id> when not hosted", () => {
    delete process.env.HOSTED_MODE;
    const scope = __internals.deriveWorkerScope();
    expect(scope).toMatch(/^local:[0-9a-f-]{36}$/);
  });
});

describe("runOneJob", () => {
  const baseSnapshot: DurableRunSnapshot = {
    runId: "run-1",
    projectId: "proj-1",
    chatboxId: "cb-1",
    personas: [{ id: "p-1", name: "Alice", role: "user", notes: "n" }],
    maxTurns: 2,
    modelId: "openai/gpt-oss-120b",
    systemPrompt: "sys",
    temperature: 0.7,
    requireToolApproval: false,
    runtimeDescriptor: {
      selectedServerIds: ["srv-1"],
      perServer: [
        {
          serverId: "srv-1",
          transportType: "http",
          url: "https://x.test/mcp",
        },
      ],
    },
  };
  const baseJob = {
    kind: "claimed" as const,
    jobId: "job-1",
    runId: "run-1",
    projectId: "proj-1",
    chatboxId: "cb-1",
    personaId: "p-1",
    sessionIndex: 0,
    attemptCount: 1,
    leaseOwner: "w-1",
    leaseExpiresAt: Date.now() + 60_000,
    runtimeDescriptor: baseSnapshot.runtimeDescriptor as Record<string, unknown>,
    persona: baseSnapshot.personas[0]!,
    maxTurns: baseSnapshot.maxTurns,
  };

  it("drives persona → assistant turns, persists chat session, completes job", async () => {
    __setFetchRunSnapshotForTesting(async () => baseSnapshot);

    sessionAgentMocks.personaNextTurnWorker
      .mockResolvedValueOnce({ message: "Q1", endSession: false })
      .mockResolvedValueOnce({ message: "Q2", endSession: true });

    const ac = new AbortController();
    await __internals.runOneJob({
      convexHttpUrl: "https://convex.test",
      job: baseJob,
      abortSignal: ac.signal,
    });

    expect(sessionAgentMocks.personaNextTurnWorker).toHaveBeenCalledTimes(2);
    expect(assistantTurnMocks.runAssistantTurn).toHaveBeenCalledTimes(1);

    // Verify ingestion was called with the v2 synthetic fields.
    expect(ingestionMocks.persistChatSessionToConvex).toHaveBeenCalledTimes(1);
    const persistArgs = ingestionMocks.persistChatSessionToConvex.mock.calls[0]![0];
    expect(persistArgs).toMatchObject({
      synthetic: true,
      personaId: "p-1",
      personaLabel: "Alice",
      visitorDisplayName: "Alice",
      synthesisRunId: "run-1",
      sourceType: "chatbox",
      surface: "share_link",
      chatboxId: "cb-1",
      modelSource: "mcpjam",
    });
    expect(persistArgs.chatSessionId).toBe("synth_run-1_p-1_0");

    expect(sessionAgentMocks.completeJob).toHaveBeenCalledTimes(1);
    expect(sessionAgentMocks.completeJob.mock.calls[0]![1]).toMatchObject({
      jobId: "job-1",
      resultChatSessionId: "synth_run-1_p-1_0",
    });
    expect(sessionAgentMocks.failJob).not.toHaveBeenCalled();
  });

  it("treats personaNextTurn lease-lost as silent abort (no failJob)", async () => {
    __setFetchRunSnapshotForTesting(async () => baseSnapshot);
    sessionAgentMocks.personaNextTurnWorker.mockRejectedValueOnce(
      new SessionWorkerLeaseLostError("Lease lost"),
    );

    const ac = new AbortController();
    await __internals.runOneJob({
      convexHttpUrl: "https://convex.test",
      job: baseJob,
      abortSignal: ac.signal,
    });

    expect(sessionAgentMocks.failJob).not.toHaveBeenCalled();
    expect(sessionAgentMocks.completeJob).not.toHaveBeenCalled();
  });

  it("classifies 501 refresh-unavailable to errorCode=refresh_unavailable", async () => {
    __setFetchRunSnapshotForTesting(async () => baseSnapshot);
    sessionAgentMocks.personaNextTurnWorker.mockRejectedValueOnce(
      new SessionWorkerRefreshUnavailableError("nope"),
    );

    const ac = new AbortController();
    await __internals.runOneJob({
      convexHttpUrl: "https://convex.test",
      job: baseJob,
      abortSignal: ac.signal,
    });

    expect(sessionAgentMocks.failJob).toHaveBeenCalledTimes(1);
    expect(sessionAgentMocks.failJob.mock.calls[0]![1]).toMatchObject({
      jobId: "job-1",
      errorCode: "refresh_unavailable",
    });
  });

  it("classifies other errors as execution_error", async () => {
    __setFetchRunSnapshotForTesting(async () => baseSnapshot);
    sessionAgentMocks.personaNextTurnWorker.mockRejectedValueOnce(
      new Error("boom"),
    );

    const ac = new AbortController();
    await __internals.runOneJob({
      convexHttpUrl: "https://convex.test",
      job: baseJob,
      abortSignal: ac.signal,
    });

    expect(sessionAgentMocks.failJob).toHaveBeenCalledTimes(1);
    expect(sessionAgentMocks.failJob.mock.calls[0]![1]).toMatchObject({
      jobId: "job-1",
      errorCode: "execution_error",
      errorMessage: "boom",
    });
  });

  it("fails fast when the run snapshot is missing", async () => {
    __setFetchRunSnapshotForTesting(async () => null);
    const ac = new AbortController();
    await __internals.runOneJob({
      convexHttpUrl: "https://convex.test",
      job: baseJob,
      abortSignal: ac.signal,
    });
    expect(sessionAgentMocks.failJob).toHaveBeenCalledTimes(1);
    expect(sessionAgentMocks.failJob.mock.calls[0]![1]).toMatchObject({
      errorCode: "execution_error",
      errorMessage: expect.stringContaining("Run snapshot not found"),
    });
  });
});
