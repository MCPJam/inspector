import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";

/**
 * The EXTERNAL-ACCOUNT turn path: a harness that authenticates on the
 * customer's own account with the runtime vendor (Cursor), so MCPJam mints no
 * lease and holds no model credential.
 *
 * Four things separate it from a brokered turn, and each is a way the turn can
 * be silently wrong rather than loudly broken:
 *   - the broker start is SKIPPED (a lease would install MCPJam's credential
 *     into the egress transform for spend MCPJam is not billed for);
 *   - the box reservation is HELD for the whole turn (nothing else takes over
 *     the per-box fence, because there is no lease to do it);
 *   - the credential comes OUT of the box's session env bag and goes to the
 *     adapter directly;
 *   - a missing credential is refused up front instead of defaulted.
 */

const harnessState = vi.hoisted(() => ({
  finalText: "done",
  session: {
    sessionId: "session-1",
    stop: vi.fn(async () => ({})),
    destroy: vi.fn(async () => {}),
    // The file-capable sandbox session the turn's `onSandboxSession` receives.
    writeTextFile: vi.fn(async () => {}),
    readTextFile: vi.fn(async () => null),
    run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  },
}));

vi.mock("@ai-sdk/harness/agent", () => ({
  HarnessAgent: class {
    // The real agent invokes `onSandboxSession` when it opens the box, BEFORE
    // the runtime process starts. The turn hangs real work off that hook (MCP
    // delivery, the credential delivery stamp, the version canary), so a double
    // that skipped it would silently not exercise any of it.
    constructor(private readonly opts: Record<string, unknown>) {}
    createSession = vi.fn(async () => {
      const onSandboxSession = this.opts.onSandboxSession as
        | ((a: { session: unknown; sessionWorkDir: string }) => Promise<void>)
        | undefined;
      await onSandboxSession?.({
        session: harnessState.session,
        sessionWorkDir: "/home/user",
      });
      return harnessState.session;
    });
    stream = vi.fn(async () => ({
      fullStream: (async function* () {
        yield { type: "finish", finishReason: "stop" };
      })(),
      text: Promise.resolve(harnessState.finalText),
    }));
  },
  collectHarnessAgentToolApprovalContinuations: vi.fn(() => []),
}));

const registryState = vi.hoisted(() => ({
  createHarness: vi.fn(() => ({ harnessId: "cursor" })),
}));

vi.mock("../registry.js", () => ({
  buildBrokerDummyAuth: vi.fn(() => {
    throw new Error(
      "buildBrokerDummyAuth must not be called for an external-account harness",
    );
  }),
  getHarnessAdapter: vi.fn(() => ({
    id: "cursor",
    displayName: "Cursor CLI",
    defaultPermissionMode: "allow-all",
    approvalPermissionMode: "allow-reads",
    supportsNativeToolApproval: true,
    supportsMcpToolApproval: false,
    supportsHostExecutedToolApproval: false,
    supportsSkills: false,
    supportsPluginBundles: false,
    requiresComputer: true,
    modelAccess: "external-account",
    externalAccountCredentialEnv: ["CURSOR_API_KEY"],
    mcpDelivery: "native",
    mcpNativeDelivery: "session-config",
    // Never consulted on this path — declared so a regression that starts
    // consulting it is visible rather than silently permissive.
    supportsModel: vi.fn(() => false),
    createHarness: registryState.createHarness,
    parseToolName: vi.fn((toolName: string) => ({ toolName })),
  })),
}));

vi.mock("../resolve-sandbox.js", () => ({
  resolveHarnessSandbox: vi.fn(async () => ({
    computerId: "computer-1",
    sandboxId: "sandbox-1",
  })),
}));

const providerState = vi.hoisted(() => ({
  lastArgs: undefined as Record<string, unknown> | undefined,
}));

vi.mock("../e2b-sandbox-provider.js", () => ({
  createE2BHarnessSandboxProvider: vi.fn((args: Record<string, unknown>) => {
    providerState.lastArgs = args;
    return { sandboxId: "sandbox-1" };
  }),
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
    // Only what the turn actually imports. `buildHarnessProxyMcpJson` is
    // deliberately NOT stubbed — it comes through from the real module, so the
    // mcpJson handed to `createHarness` below is the genuinely built object.
    harnessServerKeyToName: vi.fn((key: string) => key),
  };
});

import { runHarnessTurn } from "../run-harness-turn";
import {
  releaseHarnessBoxReservation,
  reserveHarnessBox,
  revokeHarnessModelBroker,
  startHarnessModelBroker,
} from "../harness-model-broker.js";
import { EXTERNAL_ACCOUNT_PLAN_WALL_TEXTS } from "../external-account-plan-wall";

const CURSOR_KEY = {
  name: "CURSOR_API_KEY",
  value: "key_live_abc",
  updatedAt: 1,
};
const OTHER_SECRET = {
  name: "STRIPE_API_KEY",
  value: "sk_test_123",
  updatedAt: 1,
};

function baseOptions(overrides: Record<string, unknown> = {}) {
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: "hi" }],
    } as unknown as ModelMessage,
  ];
  return {
    messages,
    modelId: "cursor/auto",
    provider: "cursor",
    systemPrompt: "You are a coding agent.",
    authHeader: "Bearer test",
    projectId: "project-1",
    mcpClientManager: { getServerConfig: vi.fn() },
    selectedServers: [],
    requireToolApproval: false,
    sourceType: "eval",
    harness: "cursor",
    runtimeSecrets: [CURSOR_KEY, OTHER_SECRET],
    ...overrides,
  };
}

beforeEach(() => {
  harnessState.finalText = "done";
  providerState.lastArgs = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 })),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.mocked(startHarnessModelBroker).mockClear();
  vi.mocked(reserveHarnessBox).mockClear();
  vi.mocked(releaseHarnessBoxReservation).mockClear();
  vi.mocked(revokeHarnessModelBroker).mockClear();
  registryState.createHarness.mockClear();
});

describe("runHarnessTurn — external-account credential path", () => {
  it("skips the broker entirely and hands the customer's key to the adapter", async () => {
    const onEngineError = vi.fn();
    await runHarnessTurn(baseOptions({ onEngineError }) as never, "none");

    expect(onEngineError).not.toHaveBeenCalled();
    // No lease minted, and therefore nothing to revoke at teardown.
    expect(startHarnessModelBroker).not.toHaveBeenCalled();
    expect(revokeHarnessModelBroker).not.toHaveBeenCalled();
    // …but the box IS still claimed: the CLI runs inside it, so the same
    // preparation race a brokered turn closes applies here too.
    expect(reserveHarnessBox).toHaveBeenCalledTimes(1);

    const args = registryState.createHarness.mock.calls[0]![0] as unknown as {
      auth: Record<string, string>;
      mcpJson: unknown;
    };
    expect(args.auth).toEqual({ CURSOR_API_KEY: CURSOR_KEY.value });
    // The `session-config` arm's signature requires it; assert it actually
    // arrives, since a turn constructed without it is silently tool-less.
    expect(args.mcpJson).toBeDefined();
  });

  it("takes the credential OUT of the box's session env, keeping the others", async () => {
    await runHarnessTurn(baseOptions() as never, "none");

    const sessionEnv = providerState.lastArgs?.sessionEnv as
      | Record<string, string>
      | undefined;
    // Reduces exposure to every OTHER command the agent shells out to in the
    // box. The Cursor process itself still receives it — that is how the CLI
    // authenticates — so this is a narrowing, not a removal.
    expect(sessionEnv).toBeDefined();
    expect(sessionEnv).not.toHaveProperty("CURSOR_API_KEY");
    expect(sessionEnv).toHaveProperty("STRIPE_API_KEY", OTHER_SECRET.value);
  });

  it("stamps delivery even when the credential is the project's ONLY secret", async () => {
    // The bag is empty in that case, so the provider's `onSessionEnvUsed` can
    // never fire and nothing else would record the delivery — making a live
    // credential read as dormant to whoever is deciding if it is safe to delete.
    const onSecretEnvDelivered = vi.fn();
    await runHarnessTurn(
      baseOptions({
        runtimeSecrets: [CURSOR_KEY],
        onSecretEnvDelivered,
      }) as never,
      "none",
    );
    expect(onSecretEnvDelivered).toHaveBeenCalled();
  });

  it("refuses up front when the credential secret is missing", async () => {
    const onEngineError = vi.fn();
    await runHarnessTurn(
      baseOptions({ runtimeSecrets: [OTHER_SECRET], onEngineError }) as never,
      "none",
    );

    expect(onEngineError).toHaveBeenCalledTimes(1);
    const err = onEngineError.mock.calls[0]![0] as { message: string };
    // Preflight-shaped copy: names the variable AND where to set it.
    expect(err.message).toContain("CURSOR_API_KEY");
    expect(err.message).toMatch(/Project Settings/i);
    expect(err.message).toContain("Cursor CLI");
    // Never defaulted to an empty or absent credential.
    expect(registryState.createHarness).not.toHaveBeenCalled();
    expect(startHarnessModelBroker).not.toHaveBeenCalled();
  });

  it("refuses when NO secrets were wired at all (not just the wrong one)", async () => {
    const onEngineError = vi.fn();
    await runHarnessTurn(
      baseOptions({ runtimeSecrets: undefined, onEngineError }) as never,
      "none",
    );
    expect(onEngineError).toHaveBeenCalledTimes(1);
    expect(
      (onEngineError.mock.calls[0]![0] as { message: string }).message,
    ).toContain("CURSOR_API_KEY");
  });

  it("hands the box back at teardown (the claim is held, not leaked)", async () => {
    // Nothing consumes the reservation on this path — no lease is minted — so
    // the turn's own teardown is the only thing that can release it. A leak
    // here makes the next Cursor turn wait out the TTL for an idle box.
    await runHarnessTurn(baseOptions() as never, "none");
    expect(releaseHarnessBoxReservation).toHaveBeenCalledTimes(1);
  });

  it("runs with broker delivery killed — it has no broker to disable", async () => {
    vi.stubEnv("MCPJAM_HARNESS_BROKER_DELIVERY", "false");
    const onEngineError = vi.fn();
    await runHarnessTurn(baseOptions({ onEngineError }) as never, "none");
    expect(onEngineError).not.toHaveBeenCalled();
    expect(registryState.createHarness).toHaveBeenCalledTimes(1);
  });

  it("fails the turn on an entitlement wall instead of persisting it as an answer", async () => {
    // Cursor answers a plan-gated request with a normal, successful-looking
    // turn. Left alone, chat persists that as the assistant's answer and an
    // eval SCORES it — a verdict about a model that never ran.
    harnessState.finalText = EXTERNAL_ACCOUNT_PLAN_WALL_TEXTS[0]!;
    const onEngineError = vi.fn();
    await runHarnessTurn(baseOptions({ onEngineError }) as never, "none");

    expect(onEngineError).toHaveBeenCalledTimes(1);
    const err = onEngineError.mock.calls[0]![0] as { message: string };
    expect(err.message).toMatch(/entitlement/i);
    expect(err.message).toContain("CURSOR_API_KEY");
  });

  it("does NOT fail a turn that merely quotes the wall text", async () => {
    harnessState.finalText = `The CLI said "${EXTERNAL_ACCOUNT_PLAN_WALL_TEXTS[0]}" — you may need a different plan.`;
    const onEngineError = vi.fn();
    await runHarnessTurn(baseOptions({ onEngineError }) as never, "none");
    expect(onEngineError).not.toHaveBeenCalled();
  });
});
