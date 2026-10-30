/**
 * A server shutdown ends an in-flight harness turn the way a Stop does, so the
 * turn's own teardown frees the chat's lane and revokes the broker lease on
 * its box before the process exits. Without it a deploy left both held until
 * their TTLs, and the next message got "Another turn is already running" or
 * "A harness run is already active on this computer".
 *
 * The module mocks are the ones `run-harness-turn-hosted-resume.test.ts`
 * drives a turn with.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";

const harnessState = vi.hoisted(() => ({
  streamStarted: undefined as (() => void) | undefined,
}));

vi.mock("@ai-sdk/harness/agent", () => ({
  HarnessAgent: class {
    createSession = vi.fn(async () => ({
      sessionId: "harness-session-0",
      stop: vi.fn(async () => ({})),
      destroy: vi.fn(async () => {}),
      detach: vi.fn(async () => ({})),
    }));
    // A model turn that runs until the turn is aborted.
    stream = vi.fn(async (opts: { abortSignal: AbortSignal }) => ({
      fullStream: (async function* () {
        yield { type: "text-delta", delta: "Working" };
        harnessState.streamStarted?.();
        await new Promise<never>((_, reject) => {
          const signal = opts.abortSignal;
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      })(),
      text: Promise.resolve(""),
    }));
    continueStream = this.stream;
  },
  collectHarnessAgentToolApprovalContinuations: vi.fn(() => []),
}));

vi.mock("../registry.js", () => ({
  buildBrokerDummyAuth: vi.fn(() => ({
    anthropic: {
      apiKey: "",
      authToken: "mcpjam-broker-dummy",
      baseUrl: "https://broker.example",
    },
  })),
  getHarnessAdapter: vi.fn(() => ({
    id: "claude-code",
    displayName: "Claude Code",
    defaultPermissionMode: "allow-all",
    supportsSkills: false,
    mcpDelivery: "host-executed",
    supportsModel: vi.fn(() => true),
    createHarness: vi.fn(() => ({ harnessId: "claude-code" })),
    parseToolName: vi.fn((toolName: string) => ({ toolName })),
  })),
}));

vi.mock("../resolve-sandbox.js", () => ({
  resolveHarnessSandbox: vi.fn(async () => ({
    computerId: "computer-1",
    sandboxId: "sandbox-1",
  })),
}));

vi.mock("../e2b-sandbox-provider.js", () => ({
  createE2BHarnessSandboxProvider: vi.fn(() => ({ sandboxId: "sandbox-1" })),
}));

vi.mock("../runtime-skills.js", () => ({
  frontmatterSafeSkills: vi.fn((skills) => skills),
  fetchRuntimeSkills: vi.fn(async () => ({ ok: true, skills: [] })),
  skillsFingerprint: vi.fn(() => "empty-skills"),
}));

vi.mock("../reconcile-skill-dirs.js", () => ({
  reconcileSkillDirs: vi.fn(async () => {}),
}));

vi.mock("../harness-session-state.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../harness-session-state.js")>();
  return {
    ...actual,
    claimHarnessSessionState: vi.fn(async () => ({
      ok: true,
      leaseId: "lease-1",
      stateVersion: 1,
      state: null,
      fingerprintChanged: false,
    })),
    commitHarnessSessionState: vi.fn(async () => true),
    heartbeatHarnessSessionState: vi.fn(async () => "ok"),
    releaseHarnessSessionState: vi.fn(async () => {}),
  };
});

vi.mock("../harness-model-broker.js", () => ({
  reserveHarnessBox: vi.fn(async () => ({ ok: true })),
  releaseHarnessBoxReservation: vi.fn(async () => ({ ok: true })),
  renewHarnessBoxReservation: vi.fn(async () => ({ ok: true })),
  revokeHarnessModelBroker: vi.fn(async () => {}),
  startHarnessModelBroker: vi.fn(async () => ({
    ok: true,
    proxyBaseUrl: "https://broker.example",
  })),
}));

vi.mock("../mcp-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp-config.js")>();
  return {
    ...actual,
    buildHarnessMcpJson: vi.fn(() => ({ mcpServers: {} })),
    harnessServerInputFromConfig: vi.fn(),
    harnessServerKeyToName: vi.fn((key: string) => key),
  };
});

import { runHarnessTurn } from "../run-harness-turn";
import { releaseHarnessSessionState } from "../harness-session-state.js";
import { revokeHarnessModelBroker } from "../harness-model-broker.js";
import {
  resetHarnessTurnShutdownForTests,
  shutdownInFlightHarnessTurns,
} from "../harness-turn-shutdown";

function options() {
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: "build me an app" }],
    } as unknown as ModelMessage,
  ];
  return {
    messages,
    modelId: "anthropic/claude-sonnet-4-6",
    provider: "anthropic",
    systemPrompt: "You are Claude Code.",
    authHeader: "Bearer test",
    projectId: "project-1",
    chatSessionId: "chat-1",
    mcpClientManager: { getServerConfig: vi.fn() },
    selectedServers: [],
    requireToolApproval: false,
    sourceType: "direct",
    harness: "claude-code",
    // The request's own signal: never aborted here, as when a deploy kills
    // the process before the client disconnects.
    abortSignal: new AbortController().signal,
  };
}

describe("runHarnessTurn on server shutdown", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token-with-enough-length");
    vi.mocked(releaseHarnessSessionState).mockClear();
    vi.mocked(revokeHarnessModelBroker).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetHarnessTurnShutdownForTests();
    harnessState.streamStarted = undefined;
  });

  it("ends a running turn and frees its chat lane and broker lease", async () => {
    const streaming = new Promise<void>((resolve) => {
      harnessState.streamStarted = resolve;
    });
    const result = await runHarnessTurn(options() as any, "ui");
    const body = result.response!.text();
    await streaming;
    expect(releaseHarnessSessionState).not.toHaveBeenCalled();

    await expect(shutdownInFlightHarnessTurns(5_000)).resolves.toEqual({
      turns: 1,
      settled: true,
    });

    await body;
    expect(releaseHarnessSessionState).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: expect.objectContaining({ chatSessionId: "chat-1" }),
      }),
    );
    // Its own deadline, not the aborted turn signal, or the release would be
    // cancelled before it left.
    const [release] = vi.mocked(releaseHarnessSessionState).mock.calls[0];
    expect(release.signal?.aborted).toBe(false);
    expect(revokeHarnessModelBroker).toHaveBeenCalledTimes(1);
  });
});
