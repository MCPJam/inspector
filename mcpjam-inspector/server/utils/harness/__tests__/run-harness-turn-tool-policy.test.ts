/**
 * D4b accounting, driven through the turn with the shape the REAL adapter
 * produces.
 *
 * `@ai-sdk/harness-claude-code`'s bridge flattens an MCP result's content blocks
 * to a bare string (`stringifyContent`), so the proxy's `_meta` marker is gone
 * by the time `tool-result` reaches us. A test built on a synthetic `_meta`
 * object would pass while production counted every refusal as a successful tool
 * call, which is the defect this file pins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { ToolPolicySnapshot } from "@mcpjam/sdk/contract";

const harnessState = vi.hoisted(() => ({
  streamParts: [] as Array<Record<string, unknown> & { type?: string }>,
  finalText: "",
  session: {
    sessionId: "session-1",
    stop: vi.fn(async () => ({})),
    destroy: vi.fn(async () => {}),
  },
}));

vi.mock("@ai-sdk/harness/agent", () => ({
  HarnessAgent: class {
    createSession = vi.fn(async () => harnessState.session);
    stream = vi.fn(async () => ({
      fullStream: (async function* () {
        for (const part of harnessState.streamParts) {
          yield part;
        }
      })(),
      text: Promise.resolve(harnessState.finalText),
    }));
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
    modelAccess: "broker",
    mcpDelivery: "native",
    // The mechanism, not just the mode: `deliverMcpServers` is only reached on
    // the `sandbox-files` arm, so a double without this would silently exercise
    // a path the real Claude Code adapter never takes.
    mcpNativeDelivery: "sandbox-files",
    deliverMcpServers: vi.fn(async () => {}),
    supportsModel: vi.fn(() => true),
    createHarness: vi.fn(() => ({ harnessId: "claude-code" })),
    // The real adapter's MCP tool names are `mcp__<key>__<tool>`; the turn only
    // needs the resolved pair, so map it directly.
    parseToolName: vi.fn((toolName: string) => ({
      toolName: toolName.replace(/^mcp__srv-a__/, ""),
      ...(toolName.startsWith("mcp__srv-a__") ? { serverId: "srv-a" } : {}),
    })),
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

vi.mock("../harness-proxy-token-client.js", () => ({
  // Convex still mints identity; the turn seals it with the policy snapshot.
  fetchHarnessProxyTokens: vi.fn(async () => ({
    ok: true,
    tokens: { "srv-a": "bare-token" },
  })),
}));

vi.mock("../reconcile-skill-dirs.js", () => ({
  reconcileSkillDirs: vi.fn(async () => {}),
}));

vi.mock("../harness-session-state.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../harness-session-state.js")
  >();
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
  revokeHarnessModelBroker: vi.fn(async () => {}),
  startHarnessModelBroker: vi.fn(async () => ({
    ok: true,
    proxyBaseUrl: "https://broker.example",
  })),
}));

import { runHarnessTurn } from "../run-harness-turn";
import type { HarnessPolicyBlockRecord } from "../harness-proxy-policy-enforcement.js";

const snapshot: ToolPolicySnapshot = {
  mode: "default",
  denied: {
    delete_repo: { reason: "denyList", classification: "destructive" },
  },
  known: ["delete_repo", "read_file"],
  unknownTool: "deny",
};

/** The parts a harness emits for one MCP tool call, with the adapter's shape. */
function toolCallParts(toolName: string, output: unknown) {
  return [
    { type: "tool-input-start", id: "call_1", toolName },
    {
      type: "tool-input-available",
      toolCallId: "call_1",
      toolName,
      input: {},
      providerExecuted: true,
    },
    {
      type: "tool-result",
      toolCallId: "call_1",
      toolName,
      // A BARE STRING, not an MCP result object — what the adapter hands us.
      output,
      providerExecuted: true,
    },
    { type: "finish", finishReason: "stop" },
  ];
}

function options(overrides: Record<string, unknown> = {}) {
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: "delete the repo" }],
    } as unknown as ModelMessage,
  ];
  return {
    messages,
    modelId: "anthropic/claude-sonnet-4-6",
    provider: "anthropic",
    systemPrompt: "You are Claude Code.",
    authHeader: "Bearer test",
    projectId: "project-1",
    mcpClientManager: { getServerConfig: vi.fn() },
    selectedServers: ["srv-a"],
    requireToolApproval: false,
    sourceType: "eval",
    harness: "claude-code",
    harnessToolPolicy: { "srv-a": snapshot },
    harnessMcpProxy: {
      plane: "web-authorized",
      mode: "direct",
      publicBaseUrl: "https://mcpjam.example",
    },
    ...overrides,
  };
}

describe("runHarnessTurn tool-policy accounting", () => {
  beforeEach(() => {
    vi.stubEnv("MCPJAM_HARNESS_BROKER_DELIVERY", "true");
    // Policied hosted runs refuse without a usable seal secret.
    vi.stubEnv(
      "COMPUTERS_TERMINAL_TOKEN_SECRET",
      "test-harness-proxy-secret-32-chars",
    );
    harnessState.finalText = "I could not delete the repo.";
    harnessState.session.stop.mockClear();
    harnessState.session.destroy.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("records a block from the adapter's flattened block text, and keeps it off the tool paths", async () => {
    harnessState.streamParts = toolCallParts(
      "mcp__srv-a__delete_repo",
      "Call blocked by tool policy: denyList",
    );
    const blocks: HarnessPolicyBlockRecord[] = [];
    const onToolResult = vi.fn(async () => {});

    const result = await runHarnessTurn(
      options({
        onToolResult,
        onHarnessPolicyBlocks: (records: HarnessPolicyBlockRecord[]) => {
          blocks.push(...records);
        },
      }) as any,
      "none",
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      toolName: "delete_repo",
      reason: "denyList",
      classification: "destructive",
      toolCallId: "call_1",
      serverId: "srv-a",
    });
    // Never a tool result and never a span: the call did not reach the server,
    // so attributing it there would derive `failed` instead of `notMeasured` +
    // `blockedByPolicy`.
    expect(onToolResult).not.toHaveBeenCalled();
    expect(
      (result.trace?.spans ?? []).some((span) => span.category === "tool"),
    ).toBe(false);
  });

  it("leaves an ordinary result alone", async () => {
    harnessState.streamParts = toolCallParts(
      "mcp__srv-a__read_file",
      "file contents",
    );
    const blocks: HarnessPolicyBlockRecord[] = [];
    const onToolResult = vi.fn(async () => {});

    await runHarnessTurn(
      options({
        onToolResult,
        onHarnessPolicyBlocks: (records: HarnessPolicyBlockRecord[]) => {
          blocks.push(...records);
        },
      }) as any,
      "none",
    );

    expect(blocks).toEqual([]);
    expect(onToolResult).toHaveBeenCalledTimes(1);
  });

  it("does not honour the block text for a tool this run's policy allows", async () => {
    // A server echoing our wording must not remove its own call from the
    // matcher: the verdict comes from the sealed snapshot, never the payload.
    harnessState.streamParts = toolCallParts(
      "mcp__srv-a__read_file",
      "Call blocked by tool policy: denyList",
    );
    const blocks: HarnessPolicyBlockRecord[] = [];
    const onToolResult = vi.fn(async () => {});

    await runHarnessTurn(
      options({
        onToolResult,
        onHarnessPolicyBlocks: (records: HarnessPolicyBlockRecord[]) => {
          blocks.push(...records);
        },
      }) as any,
      "none",
    );

    expect(blocks).toEqual([]);
    expect(onToolResult).toHaveBeenCalledTimes(1);
  });
});
