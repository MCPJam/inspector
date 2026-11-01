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
  continuations: [] as any[],
  create: vi.fn(),
  createRuntime: vi.fn(() => ({ harnessId: "codex" })),
  stream: vi.fn(),
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

/** The adapter's `toNativeModel` answer (Cursor-style adapters map none). */
const adapterDelivery = vi.hoisted(() => ({ value: "mcpjam" }));

const toNativeModel = vi.hoisted(() =>
  vi.fn((_modelId: string): string | undefined => "gpt-5")
);

vi.mock("@ai-sdk/harness/agent", () => ({
  HarnessAgent: class {
    constructor(options: Record<string, unknown>) {
      agentConstruction.last = options;
    }
    createSession = vi.fn(async () => { harnessState.create(); return harnessState.session; });
    stream = vi.fn(async (args: Record<string, unknown>) => { harnessState.stream(args); return ({
      fullStream: (async function* () {
        for (const part of harnessState.streamParts) {
          yield part;
        }
      })(),
      text: Promise.resolve(harnessState.finalText),
    }); });
  },
  collectHarnessAgentToolApprovalContinuations: vi.fn(() => harnessState.continuations),
}));

vi.mock("../registry.js", () => ({
  buildBrokerDummyAuth: vi.fn(() => ({
    anthropic: {
      apiKey: "",
      authToken: "mcpjam-broker-dummy",
      baseUrl: "https://broker.example",
    },
  })),
  getHarnessAdapter: vi.fn((id = "codex") => ({
    id,
    displayName: "Codex",
    defaultPermissionMode: "allow-all",
    approvalPermissionMode: "allow-reads",
    supportsSkills: false,
    ...adapterCapabilities.value,
    // The delivery mode under test: no `.mcp.json`, the servers ride as
    // host-executed tools MCPJam builds itself.
    mcpDelivery: adapterDelivery.value,
    mcpNativeDelivery: "session-config",
    supportsModel: vi.fn(() => true),
    toNativeModel,
    createHarness: harnessState.createRuntime,
    parseToolName: vi.fn((toolName: string) => ({ toolName })),
  })),
}));

/** The projection itself is covered by its own file; here it is a spy. */
const projectSpy = vi.hoisted(() =>
  vi.fn(async (_args: Parameters<typeof import("../host-executed-mcp-tools").projectSelectedMcpServersAsHostTools>[0]) => ({ tools: {}, keyToServerId: {} }))
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
    forwarding: {}, expiresAt: Date.now() + 60_000,
  })),
}));

const forwarding = vi.hoisted(() => ({
  allowed: false,
  admission: vi.fn((): { delivery?: "native" | "bridge"; gaps: string[] } => ({ gaps: [] })),
  prepare: vi.fn(async () => ({
    mcpJson: { mcpServers: { server: { url: "https://forward.test/mcp" } } },
    keyToServerId: { server: "srv-a" }, policyDigest: "policy", logScopeIds: {},
    isForwardedTool: () => false, stop: vi.fn(async () => {}),
  })),
}));
vi.mock("../forwarding/enhanced-admission.js", () => ({ forwardingAdmission: forwarding.admission }));
vi.mock("../forwarding/native-turn.js", async (original) => ({
  ...await original<typeof import("../forwarding/native-turn.js")>(),
  hasForwardingOrganization: () => forwarding.allowed,
  nativeForwardingSelection: () => ({ serverIds: ["srv-a"] }),
  prepareNativeForwarding: forwarding.prepare,
}));

import { runHarnessTurn } from "../run-harness-turn";
import { readMcpOriginalResult, readMcpWidgetContext } from "@/shared/mcp-tool-origin-metadata";
import { transcriptToUIMessages } from "../../../../client/src/lib/transcript-to-ui-messages";
import { convertToMcpjamModelMessages } from "../../mcp-tool-result-model-output";
import { mcpToolOptionsFor } from "../../mcp-tool-options.js";
import { markServerVerifiedApproval } from "../../tool-approval-token.js";
import { getHarnessAdapter } from "../registry.js";
import { HOSTED_APPROVAL_SANDBOX_POLICY } from "../codex-appserver/hosted-sandbox-policy.js";

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
  return (projectSpy.mock.calls[0]![0] as unknown as {
    toolOptions?: Record<string, unknown>;
  }).toolOptions;
}

describe("runHarnessTurn forwards host tool-construction options", () => {
  it("uses the MCPJam projection for Claude on its normally native adapter", async () => {
    adapterDelivery.value = "native";
    const policy = { directContent: { image: true } };
    await runHarnessTurn(baseOptions({ harness: "claude-code", agentLoop: "claude-code", modelVisibleMcpToolResults: policy }) as never, "none");
    expect(forwardedToolOptions()).toMatchObject({ modelVisibleMcpToolResults: policy });
  });

  beforeEach(() => {
    vi.stubEnv("MCPJAM_HARNESS_BROKER_DELIVERY", "true");
    adapterDelivery.value = "mcpjam";
    projectSpy.mockClear();
    harnessState.continuations = [];
    harnessState.create.mockClear();
    harnessState.stream.mockClear();
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
      "none"
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
      "none"
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
    harnessState.continuations = [];
    harnessState.create.mockClear();
    harnessState.stream.mockClear();
    await runHarnessTurn(
      baseOptions({ respectToolVisibility: true }) as never,
      "none"
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
      "none"
    );
    // A `false` is dropped by `mcpToolOptionsFor`, so a switch-off turn still
    // takes the no-options overload — see the byte-identity case below.
    expect(forwardedToolOptions()).toHaveProperty("needsApproval", false);
  });

  it("hands the plugin executor to the projection, and nothing without one", async () => {
    // The native Codex turn's MCP calls run here; the executor is what puts a
    // server's OpenAI form on the composer card and owns an App result.
    const executor = vi.fn();
    await runHarnessTurn(
      baseOptions({ hostToolExecutor: executor }) as never,
      "none"
    );
    const forwarded = () =>
      (projectSpy.mock.calls as unknown as Array<[{ executor?: unknown }]>)[0]![0];
    expect(forwarded().executor).toBe(executor);

    projectSpy.mockClear();
    await runHarnessTurn(baseOptions() as never, "none");
    expect(forwarded()).not.toHaveProperty("executor");
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

    it("withholds a workspace tool that pauses from a runtime that cannot pause on a host tool (MJ-008)", async () => {
      adapterCapabilities.value = {
        ...APPROVAL_CAPABLE,
        supportsHostExecutedToolApproval: false,
      };

      await runHarnessTurn(
        baseOptions({
          requireToolApproval: false,
          selectedServers: [],
          builtInTools: {
            create_project_server: markServerVerifiedApproval({
              needsApproval: true,
              execute: vi.fn(),
            }),
            list_projects: { needsApproval: false, execute: vi.fn() },
          },
        }) as never,
        "none",
      );

      expect(Object.keys(agentConstruction.last?.tools ?? {})).toEqual([
        "list_projects",
      ]);
      expect(agentConstruction.last).not.toHaveProperty("toolApproval");
      expect(agentConstruction.last?.tools ?? {}).not.toHaveProperty("bash");
    });

    it("hands a workspace tool that pauses to a runtime that can pause on it, gated (MJ-008)", async () => {
      adapterCapabilities.value = APPROVAL_CAPABLE;

      await runHarnessTurn(
        baseOptions({
          requireToolApproval: false,
          selectedServers: [],
          builtInTools: {
            create_project_server: markServerVerifiedApproval({
              needsApproval: true,
              execute: vi.fn(),
            }),
            list_projects: { needsApproval: false, execute: vi.fn() },
          },
        }) as never,
        "none",
      );

      expect(Object.keys(agentConstruction.last?.tools ?? {}).sort()).toEqual([
        "create_project_server",
        "list_projects",
      ]);
      expect(agentConstruction.last?.toolApproval).toEqual({
        create_project_server: "user-approval",
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
          sourceType: "direct",
          builtInTools: { bash: { needsApproval: true } },
        }) as never,
        "none",
      );

      expect(agentConstruction.last).toBeDefined();
      expect(agentConstruction.last).not.toHaveProperty("toolApproval");
      expect(agentConstruction.last?.tools ?? {}).not.toHaveProperty("bash");
    });
  });

  describe("the native model", () => {
    afterEach(() => {
      toNativeModel.mockReset();
      toNativeModel.mockImplementation(() => "gpt-5");
      agentConstruction.last = undefined;
    });

    it("hands the adapter's native model to HarnessAgent", async () => {
      // The AI SDK adapters stopped reading a construction-time `model`
      // setting, so the agent is the only place the selected model reaches
      // the runtime. Without it Codex runs its own default model and Claude
      // Code its CLI default, under the selected model's name.
      await runHarnessTurn(baseOptions() as never, "none");
      expect(toNativeModel).toHaveBeenCalledWith("openai/gpt-5");
      expect(agentConstruction.last?.model).toBe("gpt-5");
    });

    it("passes no model when the adapter maps none", async () => {
      // Cursor's `toNativeModel` answers undefined: Cursor Auto picks on the
      // customer's account, so the agent must not carry a model at all.
      toNativeModel.mockImplementation(() => undefined);
      await runHarnessTurn(baseOptions() as never, "none");
      expect(agentConstruction.last).toBeDefined();
      expect(agentConstruction.last).not.toHaveProperty("model");
    });
  });
});

it("refuses hosted approval resumes with no paused state instead of replaying a prompt", async () => {
  harnessState.continuations = [{ type: "tool-approval-response", approvalId: "old", approved: true }];
  harnessState.create.mockClear(); harnessState.stream.mockClear();
  const result = await runHarnessTurn(baseOptions({ sourceType: "direct", chatSessionId: "chat", selectedServers: [] }) as never, "ui");
  expect(await result.response!.text()).toContain("pending action will not run");
  expect(harnessState.create).not.toHaveBeenCalled();
  expect(harnessState.stream).not.toHaveBeenCalled();
  harnessState.continuations = [];
});

describe("the hosted command sandbox under Tool Approval", () => {
  const CODEX_LIKE = {
    supportsNativeToolApproval: true,
    supportsHostExecutedToolApproval: true,
    supportsMcpToolApproval: false,
    acceptsSandboxPolicy: true,
  };
  const createHarnessArgs = () => {
    const adapter = vi.mocked(getHarnessAdapter).mock.results.at(-1)!.value;
    return vi.mocked(adapter.createHarness).mock.calls.at(-1)?.[0] as
      | Record<string, unknown>
      | undefined;
  };

  beforeEach(() => {
    vi.stubEnv("MCPJAM_HARNESS_BROKER_DELIVERY", "true");
    adapterDelivery.value = "mcpjam";
    vi.mocked(getHarnessAdapter).mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    adapterCapabilities.value = {
      supportsNativeToolApproval: false,
      supportsHostExecutedToolApproval: false,
      supportsMcpToolApproval: false,
    };
  });

  // Measured on the `mcpjam-computer` template: under Codex's default
  // workspace-write sandbox an APPROVED `curl` could not resolve a host while
  // the same command with approval off returned 200. The box is the boundary,
  // so approving must grant what off grants.
  it("opens the sandbox to the box when the turn pauses for approval", async () => {
    adapterCapabilities.value = CODEX_LIKE;
    await runHarnessTurn(
      baseOptions({ requireToolApproval: true, sourceType: "direct" }) as never,
      "none",
    );
    expect(createHarnessArgs()?.sandboxPolicy).toEqual(
      HOSTED_APPROVAL_SANDBOX_POLICY,
    );
    expect(HOSTED_APPROVAL_SANDBOX_POLICY).toMatchObject({
      networkAccess: true,
      writableRoots: ["/"],
    });
  });

  it("sets no policy with approval off (full access in the box, as before)", async () => {
    adapterCapabilities.value = CODEX_LIKE;
    await runHarnessTurn(
      baseOptions({ requireToolApproval: false, sourceType: "direct" }) as never,
      "none",
    );
    expect(createHarnessArgs()).not.toHaveProperty("sandboxPolicy");
  });

  it("never hands a policy to a runtime that cannot apply one", async () => {
    adapterCapabilities.value = { ...CODEX_LIKE, acceptsSandboxPolicy: false };
    await runHarnessTurn(
      baseOptions({ requireToolApproval: true, sourceType: "direct" }) as never,
      "none",
    );
    expect(createHarnessArgs()).not.toHaveProperty("sandboxPolicy");
  });
});


it.each(["claude-code", "codex"] as const)("delivers %s App context per turn without changing instructions", async (harness) => {
  const options = baseOptions({ harness, agentLoop: harness, sourceType: "direct", selectedServers: [], systemPrompt: "stable instructions" });
  await runHarnessTurn({ ...options, harnessTurnContext: "widget state one" } as never, "none");
  const firstInstructions = agentConstruction.last?.instructions;
  expect(JSON.stringify(harnessState.stream.mock.calls.at(-1))).toContain("widget state one");
  await runHarnessTurn({ ...options, harnessTurnContext: "widget state two", harnessUnavailableAppTools: true } as never, "none");
  expect(agentConstruction.last?.instructions).toEqual(firstInstructions);
  expect(JSON.stringify(harnessState.stream.mock.calls.at(-1))).toContain("widget state two");
});


describe("enrolled Claude forwarding admission", () => {
  beforeEach(() => {
    vi.stubEnv("MCPJAM_HARNESS_BROKER_DELIVERY", "true");
    vi.stubEnv("HARNESS_NATIVE_FORWARDING", "true");
    forwarding.allowed = true;
    forwarding.admission.mockReset().mockReturnValue({ delivery: "native", gaps: [] });
    forwarding.prepare.mockClear();
    projectSpy.mockClear();
    harnessState.stream.mockClear();
    adapterDelivery.value = "harness";
    harnessState.createRuntime.mockClear();
  });
  afterEach(() => { forwarding.allowed = false; vi.unstubAllEnvs(); });
  const enrolled = () => baseOptions({
    harness: "claude-code", agentLoop: "claude-code", sourceType: "direct",
    hostId: "host-claude", chatSessionId: "chat-claude",
    harnessMcpProxy: { plane: "web-authorized", mode: "relay" },
  });
  it("uses forwarding instead of projecting the same tools twice when admitted", async () => {
    await runHarnessTurn(enrolled() as never, "none");
    expect(forwarding.admission).toHaveBeenCalledOnce();
    expect(forwarding.prepare).toHaveBeenCalledOnce();
    expect(harnessState.createRuntime).toHaveBeenCalledWith(expect.objectContaining({
      mcpJson: { mcpServers: { server: { url: "https://forward.test/mcp" } } },
    }));
    expect(projectSpy).not.toHaveBeenCalled();
    expect(harnessState.stream).toHaveBeenCalledOnce();
  });
  it("keeps the configured bridge when the profile does not qualify", async () => {
    forwarding.admission.mockReturnValue({ gaps: ["unqualified-protocol"] });
    await runHarnessTurn(enrolled() as never, "none");
    expect(forwarding.admission).toHaveBeenCalledOnce();
    expect(forwarding.prepare).not.toHaveBeenCalled();
    expect(projectSpy).toHaveBeenCalledOnce();
    expect(harnessState.stream).toHaveBeenCalledOnce();
  });
  it.each(["flag-disabled", "eval-surface"])("retains the bridge for %s", async reason => {
    if (reason === "flag-disabled") vi.stubEnv("HARNESS_NATIVE_FORWARDING", "false");
    const options = enrolled();
    if (reason === "eval-surface") Object.assign(options, { sourceType: "eval", evalIterationId: "iteration" });
    await runHarnessTurn(options as never, "none");
    expect(forwarding.admission).not.toHaveBeenCalled();
    expect(forwarding.prepare).not.toHaveBeenCalled();
    expect(projectSpy).toHaveBeenCalledOnce();
  });
  it("keeps other organizations on their configured bridge", async () => {
    forwarding.allowed = false;
    await runHarnessTurn(enrolled() as never, "none");
    expect(forwarding.admission).not.toHaveBeenCalled();
    expect(forwarding.prepare).not.toHaveBeenCalled();
    expect(projectSpy).toHaveBeenCalledOnce();
  });
});


it("keeps retained App presentation separate from saved model history", async () => {
  vi.stubEnv("MCPJAM_HARNESS_BROKER_DELIVERY", "true");
  adapterDelivery.value = "mcpjam";
  const raw = { content: [{ type: "text", text: "visible" }], _meta: { private: "WIDGET_PRIVATE_SENTINEL" }, structuredContent: { privateValue: 7 } };
  const projected = { type: "text", value: "visible" };
  const onConversationComplete = vi.fn();
  projectSpy.mockImplementationOnce(async args => {
    args.onRawResult?.({ toolCallId: "app-call", raw });
    return { tools: {}, keyToServerId: {} };
  });
  harnessState.streamParts = [
    { type: "tool-call", toolCallId: "app-call", toolName: "app", input: {} },
    { type: "tool-result", toolCallId: "app-call", toolName: "app", output: projected },
    { type: "finish", finishReason: "stop" },
  ];
  try {
    const turn = await runHarnessTurn(baseOptions({ onConversationComplete }) as never, "ui");
    const wire = await turn.response!.text();
    const chunks = wire.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    const outputChunk = chunks.find(chunk => chunk.type === "tool-output-available");
    expect(outputChunk.output).toEqual(projected);
    expect(readMcpOriginalResult(outputChunk.providerMetadata)).toEqual(raw);
    expect(readMcpWidgetContext(outputChunk.providerMetadata)).toBeUndefined();
    expect(onConversationComplete).toHaveBeenCalledOnce();
    const history = onConversationComplete.mock.calls[0][0];
    const result = history.flatMap((message: ModelMessage) => Array.isArray(message.content) ? message.content : []).find((part: {type: string}) => part.type === "tool-result");
    expect(result).toMatchObject({ output: projected, result: raw });
    const ui = transcriptToUIMessages(history);
    const app = ui.flatMap(message => message.parts).find(part => "toolCallId" in part);
    expect(app && "callProviderMetadata" in app && readMcpOriginalResult(app.callProviderMetadata)).toEqual(raw);
    expect(app && "callProviderMetadata" in app && readMcpWidgetContext(app.callProviderMetadata)).toBeUndefined();
    const freshHistory = await convertToMcpjamModelMessages(ui);
    expect(JSON.stringify(freshHistory)).toContain("visible");
    expect(JSON.stringify(freshHistory)).not.toContain("WIDGET_PRIVATE_SENTINEL");
    expect(JSON.stringify(freshHistory)).not.toContain("privateValue");
  } finally {
    harnessState.streamParts = [{ type: "finish", finishReason: "stop" }];
    vi.unstubAllEnvs();
  }
});
