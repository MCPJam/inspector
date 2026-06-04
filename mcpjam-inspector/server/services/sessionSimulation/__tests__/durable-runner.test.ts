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

import { getRunnerMode, __internals } from "../durable-runner";

import {
  SessionWorkerLeaseLostError,
  SessionWorkerRefreshUnavailableError,
  type ClaimedJob,
  type PersonaSlate,
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
  it("defaults to durable (flipped 2026-06-04)", () => {
    delete process.env.SYNTHESIS_RUNNER_MODE;
    expect(getRunnerMode()).toBe("durable");
  });
  it("returns in_process when the operator sets the explicit opt-out", () => {
    process.env.SYNTHESIS_RUNNER_MODE = "in_process";
    expect(getRunnerMode()).toBe("in_process");
  });
  it("returns durable when env literal is explicitly set", () => {
    process.env.SYNTHESIS_RUNNER_MODE = "durable";
    expect(getRunnerMode()).toBe("durable");
  });
  it("any other env value falls back to durable (avoids silent typo switch)", () => {
    process.env.SYNTHESIS_RUNNER_MODE = "other";
    expect(getRunnerMode()).toBe("durable");
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
  const persona: PersonaSlate = {
    id: "p-1",
    name: "Alice",
    role: "user",
    notes: "n",
  };
  const baseDescriptor: Record<string, unknown> = {
    selectedServerIds: ["srv-1"],
    perServer: [
      { serverId: "srv-1", transportType: "http", url: "https://x.test/mcp" },
    ],
    chatboxConfig: {
      modelId: "openai/gpt-oss-120b",
      modelSource: "mcpjam",
      systemPrompt: "sys",
      temperature: 0.7,
      requireToolApproval: false,
    },
  };
  const baseJob: ClaimedJob = {
    kind: "claimed",
    jobId: "job-1",
    runId: "run-1",
    projectId: "proj-1",
    chatboxId: "cb-1",
    personaId: "p-1",
    sessionIndex: 0,
    attemptCount: 1,
    leaseOwner: "w-1",
    leaseExpiresAt: Date.now() + 60_000,
    runtimeDescriptor: baseDescriptor,
    persona,
    maxTurns: 2,
  };

  it("drives persona → assistant turns, persists chat session via worker mode, completes job", async () => {
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

    // Verify ingestion was called with worker mode + synthetic fields.
    expect(ingestionMocks.persistChatSessionToConvex).toHaveBeenCalledTimes(1);
    const persistArgs = ingestionMocks.persistChatSessionToConvex.mock.calls[0]![0];
    expect(persistArgs).toMatchObject({
      ingestMode: "worker",
      serviceToken: "tok",
      synthetic: true,
      personaId: "p-1",
      personaLabel: "Alice",
      visitorDisplayName: "Alice",
      synthesisRunId: "run-1",
      sourceType: "chatbox",
      surface: "share_link",
      chatboxId: "cb-1",
      projectId: "proj-1",
      modelSource: "mcpjam",
    });
    expect(persistArgs.chatSessionId).toBe("synth_run-1_p-1_0");

    expect(sessionAgentMocks.completeJob).toHaveBeenCalledTimes(1);
    expect(sessionAgentMocks.completeJob.mock.calls[0]![1]).toMatchObject({
      jobId: "job-1",
      leaseOwner: "w-1",
      resultChatSessionId: "synth_run-1_p-1_0",
    });
    expect(sessionAgentMocks.failJob).not.toHaveBeenCalled();
  });

  it("terminal-fails with errorCode=missing_descriptor when claim has runtimeDescriptor: null", async () => {
    const ac = new AbortController();
    await __internals.runOneJob({
      convexHttpUrl: "https://convex.test",
      job: { ...baseJob, runtimeDescriptor: null },
      abortSignal: ac.signal,
    });

    expect(sessionAgentMocks.failJob).toHaveBeenCalledTimes(1);
    expect(sessionAgentMocks.failJob.mock.calls[0]![1]).toMatchObject({
      jobId: "job-1",
      leaseOwner: "w-1",
      errorCode: "missing_descriptor",
    });
    // No manager build, no chat ingestion, no completion.
    expect(managerBuildMocks.buildSynthesisManager).not.toHaveBeenCalled();
    expect(ingestionMocks.persistChatSessionToConvex).not.toHaveBeenCalled();
    expect(sessionAgentMocks.completeJob).not.toHaveBeenCalled();
  });

  it("treats personaNextTurn lease-lost as silent abort (no failJob)", async () => {
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
});
