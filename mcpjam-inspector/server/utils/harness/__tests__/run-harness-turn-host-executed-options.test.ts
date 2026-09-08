/**
 * The turn must hand the HOST's tool-construction inputs to the host-executed
 * MCP projection.
 *
 * `getToolsForAiSdk` resolves none of them itself, so anything the turn does
 * not forward is not "defaulted" — it is gone. This file pins the wiring;
 * `host-executed-mcp-tools.test.ts` pins what the projection then does with it.
 *
 * The `modelVisibleMcpToolResults` and `tasks` assertions fail against the
 * previous behaviour, where the projection was called with no options at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";

/**
 * The approval capabilities the adapter advertises. Overridden by the cases
 * that exercise the derived `toolApproval` map, because a turn whose adapter
 * cannot pause is refused before it ever builds one.
 */
const adapterCapabilities = vi.hoisted(() => ({
  value: {
    supportsNativeToolApproval: false,
    supportsHostExecutedToolApproval: false,
    supportsMcpToolApproval: false,
  } as Record<string, boolean>,
}));

const harnessState = vi.hoisted(() => ({
  streamParts: [{ type: "finish", finishReason: "stop" }] as Array<
    Record<string, unknown> & { type?: string }
  >,
  finalText: "done",
  session: {
    sessionId: "session-1",
    stop: vi.fn(async () => ({})),
    destroy: vi.fn(async () => {}),
  },
}));

/** What `HarnessAgent` was constructed with on the last turn. */
const agentConstruction = vi.hoisted(() => ({
  last: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@ai-sdk/harness/agent", () => ({
  HarnessAgent: class {
    constructor(options: Record<string, unknown>) {
      agentConstruction.last = options;
    }
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
    id: "codex",
    displayName: "Codex",
    defaultPermissionMode: "allow-all",
    approvalPermissionMode: "allow-reads",
    supportsSkills: false,
    ...adapterCapabilities.value,
    // The delivery mode under test: no `.mcp.json`, the servers ride as
    // host-executed tools MCPJam builds itself.
    mcpDelivery: "host-executed",
    supportsModel: vi.fn(() => true),
    createHarness: vi.fn(() => ({ harnessId: "codex" })),
    parseToolName: vi.fn((toolName: string) => ({ toolName })),
  })),
}));

/** The projection itself is covered by its own file; here it is a spy. */
const projectSpy = vi.hoisted(() =>
  vi.fn(async () => ({ tools: {}, keyToServerId: {} })),
);
vi.mock("../host-executed-mcp-tools.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../host-executed-mcp-tools.js")
  >();
  return { ...actual, projectSelectedMcpServersAsHostTools: projectSpy };
});

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
import { mcpToolOptionsFor } from "../../mcp-tool-options.js";

function baseOptions(overrides: Record<string, unknown> = {}) {
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: "list the open issues" }],
    } as unknown as ModelMessage,
  ];
  return {
    messages,
    modelId: "openai/gpt-5",
    provider: "openai",
    systemPrompt: "You are Codex.",
    authHeader: "Bearer test",
    projectId: "project-1",
    mcpClientManager: { getServerConfig: vi.fn(() => ({ url: "x" })) },
    selectedServers: ["srv-a"],
    // Required whenever servers are selected, even on host-executed delivery
    // (the turn asserts it before it knows which arm it is on).
    harnessMcpProxy: { plane: "local-mcp" as const },
    requireToolApproval: false,
    sourceType: "eval",
    harness: "codex",
    ...overrides,
  };
}

/** The `toolOptions` the turn handed the projection. */
function forwardedToolOptions() {
  expect(projectSpy).toHaveBeenCalledTimes(1);
  return (
    projectSpy.mock.calls[0]![0] as unknown as {
      toolOptions?: Record<string, unknown>;
    }
  ).toolOptions;
}

describe("runHarnessTurn forwards host tool-construction options", () => {
  beforeEach(() => {
    vi.stubEnv("MCPJAM_HARNESS_BROKER_DELIVERY", "true");
    projectSpy.mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("forwards the host's modelVisibleMcpToolResults", async () => {
    // THE REPORTED BUG: the projection used to be called with no options, so
    // this policy never reached the tool the relay executes.
    const policy = {
      directContent: { image: true },
      embeddedResources: { blob: { image: false } },
      linkedResources: { blob: { image: false } },
    };
    await runHarnessTurn(
      baseOptions({ modelVisibleMcpToolResults: policy }) as never,
      "none",
    );
    expect(forwardedToolOptions()).toMatchObject({
      modelVisibleMcpToolResults: policy,
    });
  });

  it("forwards the resolved task seam", async () => {
    const tasks = { mode: "await" };
    await runHarnessTurn(baseOptions({ tasks }) as never, "none");
    expect(forwardedToolOptions()).toMatchObject({ tasks });
  });

  it("turns an explicit respectToolVisibility=false into includeAppOnly", async () => {
    await runHarnessTurn(
      baseOptions({ respectToolVisibility: false }) as never,
      "none",
    );
    expect(forwardedToolOptions()).toMatchObject({ includeAppOnly: true });
  });

  it("keeps the spec default when respectToolVisibility is unset or true", async () => {
    // `undefined` and `true` both filter app-only tools; only an explicit
    // `false` opts out, exactly as `prepareChatV2` reads it. A `false` here is
    // dropped by `mcpToolOptionsFor`, so it never reaches the SDK.
    await runHarnessTurn(baseOptions() as never, "none");
    expect(forwardedToolOptions()?.includeAppOnly).toBe(false);

    projectSpy.mockClear();
    await runHarnessTurn(
      baseOptions({ respectToolVisibility: true }) as never,
      "none",
    );
    expect(forwardedToolOptions()?.includeAppOnly).toBe(false);
  });

  it("forwards the host's approval switch, which is what the toolApproval map is built from", async () => {
    // It used to forward nothing here, on the grounds that the AI SDK flag was
    // inert on this path. It is not inert now: `runHarnessTurn` derives
    // `HarnessAgent`'s `toolApproval` map from each projection's own
    // declaration, so a projection built without one is a tool the harness
    // will not pause on.
    //
    // The SWITCH-ON case cannot be driven through this file's adapter — it
    // advertises no approval support at all, so the turn is refused before it
    // reaches the projection, which is `harnessToolApprovalRefusalReason`
    // doing its job. What is asserted here is the wiring: the switch is
    // threaded rather than omitted. `host-executed-mcp-tools.test.ts` covers
    // what the projection does with a `true`.
    await runHarnessTurn(
      baseOptions({ requireToolApproval: false }) as never,
      "none",
    );
    // A `false` is dropped by `mcpToolOptionsFor`, so a switch-off turn still
    // takes the no-options overload — see the byte-identity case below.
    expect(forwardedToolOptions()).toHaveProperty("needsApproval", false);
  });

  it("leaves a DEFAULT turn on the no-options path", async () => {
    // Byte-identity guard (it passes against the previous behaviour too, and
    // is here to keep passing): whatever the turn forwards for a host that set
    // none of these must still build to `undefined`, so the enumeration calls
    // `getToolsForAiSdk(ids)` exactly as it did before any of this existed.
    await runHarnessTurn(baseOptions() as never, "none");
    expect(mcpToolOptionsFor(forwardedToolOptions() ?? {})).toBeUndefined();
  });

  describe("the derived toolApproval map", () => {
    const APPROVAL_CAPABLE = {
      supportsNativeToolApproval: true,
      supportsHostExecutedToolApproval: true,
      supportsMcpToolApproval: true,
    };

    afterEach(() => {
      adapterCapabilities.value = {
        supportsNativeToolApproval: false,
        supportsHostExecutedToolApproval: false,
        supportsMcpToolApproval: false,
      };
      agentConstruction.last = undefined;
    });

    it("names the tools that ASK, not every tool the turn advertised", async () => {
      // The map used to be built over every key of `hostExecutedTools`, so a
      // switch-on turn asked before an exa search and a workspace read — a
      // pill for something the other two engines run without one. It is
      // derived from the same declaration they read now.
      adapterCapabilities.value = APPROVAL_CAPABLE;
      projectSpy.mockResolvedValueOnce({
        tools: {
          mcp__srv__write: { needsApproval: true },
          mcp__srv__read: { needsApproval: false },
        },
        keyToServerId: {},
      } as never);

      await runHarnessTurn(
        baseOptions({
          requireToolApproval: true,
          builtInTools: {
            // Floor `never`: declared, and the map must respect it.
            web_search: { needsApproval: false },
            // Floor `always` on the local engine.
            bash: { needsApproval: true },
          },
        }) as never,
        "none",
      );

      expect(agentConstruction.last?.toolApproval).toEqual({
        mcp__srv__write: "user-approval",
        bash: "user-approval",
      });
    });

    it("counts a FUNCTION declaration as asking", async () => {
      // Unevaluable before the model has produced an input, and the map has to
      // exist now — so the fail-closed reading is the only sound one.
      adapterCapabilities.value = APPROVAL_CAPABLE;
      projectSpy.mockResolvedValueOnce({
        tools: { mcp__srv__load: { needsApproval: () => false } },
        keyToServerId: {},
      } as never);

      await runHarnessTurn(
        baseOptions({ requireToolApproval: true }) as never,
        "none",
      );

      expect(agentConstruction.last?.toolApproval).toEqual({
        mcp__srv__load: "user-approval",
      });
    });

    it("builds NO map at all when the adapter cannot pause on a host tool", async () => {
      // Advertise = enforce, and the capability still gates the WHOLE map
      // rather than being folded into the per-tool read: a map that claims a
      // runtime will pause when it cannot is worse than no map.
      //
      // No selected servers, so `harnessToolApprovalRefusalReason` lets the
      // turn run (its MCP arm only applies when there are servers) and the
      // built-in below is the only thing that could have been gated.
      adapterCapabilities.value = {
        ...APPROVAL_CAPABLE,
        supportsHostExecutedToolApproval: false,
      };

      await runHarnessTurn(
        baseOptions({
          requireToolApproval: true,
          selectedServers: [],
          builtInTools: { bash: { needsApproval: true } },
        }) as never,
        "none",
      );

      expect(agentConstruction.last).toBeDefined();
      expect(agentConstruction.last).not.toHaveProperty("toolApproval");
    });
  });
});
