import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";

/**
 * The EXTERNAL-ACCOUNT turn path: a harness that runs on the organization's own
 * account with the runtime vendor (Cursor), so MCPJam mints no lease and holds
 * no model credential.
 *
 * What separates it from a brokered turn, each a way it could be silently
 * wrong rather than loudly broken:
 *   - the broker start is SKIPPED;
 *   - the box reservation is HELD for the whole turn;
 *   - the adapter gets a placeholder, never a key, and only once the backend
 *     says the org key is ready; otherwise the turn stops before any box;
 *   - the vendor tokens the CLI exchanged leave the box at every turn end.
 */
const loginState = vi.hoisted(() => ({
  install: vi.fn(async () => {}),
  clear: vi.fn(async () => {}),
}));
vi.mock("../runtime-login.js", () => ({
  cursorRuntimeLogin: () => loginState,
}));

const harnessState = vi.hoisted(() => ({
  finalText: "done",
  /** Throw from `createSession` AFTER the box opened (the CLI may have
   *  authenticated by then). */
  createSessionError: null as Error | null,
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
      if (harnessState.createSessionError)
        throw harnessState.createSessionError;
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
    mcpDelivery: "harness",
    mcpNativeDelivery: "session-config",
    // Never consulted on this path — declared so a regression that starts
    // consulting it is visible rather than silently permissive.
    supportsModel: vi.fn(() => false),
    createHarness: registryState.createHarness,
    parseToolName: vi.fn((toolName: string) => ({ toolName })),
  })),
}));

vi.mock("../../computers/convex-secrets-client.js", () => ({
  convexListProjectSecretBindings: vi.fn(async () => []),
  convexGetEnvironmentSecretSelection: vi.fn(async () => []),
  convexListSecretsForRuntimeExecution: vi.fn(async () => []),
  convexMarkSecretsDelivered: vi.fn(async () => ({ marked: 0 })),
}));

/** The backend's answer about the org key. */
const readinessState = vi.hoisted(() => ({
  answer: { ok: true, value: { readiness: "ready" } } as unknown,
}));

vi.mock("../../computers/control-plane-client.js", () => ({
  getHarnessCredentialReadiness: vi.fn(async () => readinessState.answer),
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
import { resolveHarnessSandbox } from "../resolve-sandbox.js";
import { getHarnessCredentialReadiness } from "../../computers/control-plane-client.js";
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
const MISSING =
  "Ask an org admin to add a Cursor key in Organization → AI providers.";

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
    environmentId: "env-1",
    harnessSandboxBinding: { sandboxRowId: "sandbox-1", sandboxId: "box-1" },
    runtimeSecrets: [OTHER_SECRET],
    ...overrides,
  };
}

beforeEach(() => {
  loginState.install.mockReset().mockResolvedValue(undefined);
  loginState.clear.mockReset().mockResolvedValue(undefined);
  harnessState.session.destroy.mockClear();
  harnessState.finalText = "done";
  harnessState.createSessionError = null;
  providerState.lastArgs = undefined;
  readinessState.answer = { ok: true, value: { readiness: "ready" } };
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
  vi.mocked(resolveHarnessSandbox).mockClear();
  vi.mocked(getHarnessCredentialReadiness).mockClear();
  harnessState.session.run.mockClear();
  registryState.createHarness.mockClear();
});

describe("runHarnessTurn — external-account (org key)", () => {
  it("skips the broker and hands the adapter only an empty key", async () => {
    const onEngineError = vi.fn();
    await runHarnessTurn(baseOptions({ onEngineError }) as never, "none");

    expect(onEngineError).not.toHaveBeenCalled();
    expect(getHarnessCredentialReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1", harnessId: "cursor" }),
    );
    // No lease minted, and therefore nothing to revoke at teardown.
    expect(startHarnessModelBroker).not.toHaveBeenCalled();
    expect(revokeHarnessModelBroker).not.toHaveBeenCalled();
    // The box IS still claimed: the CLI runs inside it.
    expect(reserveHarnessBox).toHaveBeenCalledTimes(1);
    const args = registryState.createHarness.mock.calls[0]![0] as unknown as {
      auth: Record<string, string>;
      mcpJson: unknown;
    };
    // The key never reaches this process; the backend installs a temporary login.
    expect(args.auth).toEqual({ CURSOR_API_KEY: "" });
    expect(args.mcpJson).toBeDefined();
  });

  it("never puts a project or member Cursor key on the box, keeping the other secrets", async () => {
    await runHarnessTurn(
      baseOptions({ runtimeSecrets: [CURSOR_KEY, OTHER_SECRET] }) as never,
      "none",
    );
    const sessionEnv = providerState.lastArgs?.sessionEnv as
      | Record<string, string>
      | undefined;
    expect(sessionEnv).not.toHaveProperty("CURSOR_API_KEY");
    expect(sessionEnv).toHaveProperty("STRIPE_API_KEY", OTHER_SECRET.value);
    const args = registryState.createHarness.mock.calls[0]![0] as unknown as {
      auth: Record<string, string>;
    };
    expect(args.auth.CURSOR_API_KEY).toBe("");
  });

  it("stamps no delivery for the org key: this process never held it", async () => {
    const onSecretEnvDelivered = vi.fn();
    await runHarnessTurn(
      baseOptions({
        runtimeSecrets: [CURSOR_KEY],
        onSecretEnvDelivered,
      }) as never,
      "none",
    );
    expect(onSecretEnvDelivered).not.toHaveBeenCalled();
  });

  it.each(["missing", "invalid"])(
    "stops before any box when the org key is %s",
    async (readiness) => {
      readinessState.answer = { ok: true, value: { readiness } };
      const onEngineError = vi.fn();
      await runHarnessTurn(baseOptions({ onEngineError }) as never, "none");

      expect(onEngineError).toHaveBeenCalledTimes(1);
      expect((onEngineError.mock.calls[0]![0] as Error).message).toBe(MISSING);
      // Nothing was reserved, opened or started.
      expect(reserveHarnessBox).not.toHaveBeenCalled();
      expect(resolveHarnessSandbox).not.toHaveBeenCalled();
      expect(providerState.lastArgs).toBeUndefined();
      expect(registryState.createHarness).not.toHaveBeenCalled();
      expect(startHarnessModelBroker).not.toHaveBeenCalled();
    },
  );

  it("stops before any box when readiness can't be read", async () => {
    readinessState.answer = { ok: false, status: 503, error: "down" };
    const onEngineError = vi.fn();
    await runHarnessTurn(baseOptions({ onEngineError }) as never, "none");
    expect((onEngineError.mock.calls[0]![0] as Error).message).toMatch(
      /Couldn't check your organization's Cursor key/,
    );
    expect(reserveHarnessBox).not.toHaveBeenCalled();
    expect(registryState.createHarness).not.toHaveBeenCalled();
  });

  it("refuses a NON-MEMBER participant before asking about any key", async () => {
    const onEngineError = vi.fn();
    await runHarnessTurn(
      baseOptions({ scenarioParticipant: true, onEngineError }) as never,
      "none",
    );
    const err = onEngineError.mock.calls[0]![0] as { message: string };
    expect(err.message).toContain("isn't available to participants");
    expect(getHarnessCredentialReadiness).not.toHaveBeenCalled();
    expect(registryState.createHarness).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a User Testing turn",
      "scenario",
      "Choose a different client for this study.",
    ],
    [
      "an MCP Events run",
      "event",
      "Use it there, or choose a different client.",
    ],
  ])(
    "refuses %s before asking about any key",
    async (_label, sourceType, next) => {
      const onEngineError = vi.fn();
      await runHarnessTurn(
        baseOptions({
          sourceType,
          scenarioId: "scenario-1",
          onEngineError,
        }) as never,
        "none",
      );
      expect((onEngineError.mock.calls[0]![0] as Error).message).toBe(
        `Cursor CLI runs only in the Playground, evals and swarms. ${next}`,
      );
      expect(getHarnessCredentialReadiness).not.toHaveBeenCalled();
      expect(reserveHarnessBox).not.toHaveBeenCalled();
      expect(registryState.createHarness).not.toHaveBeenCalled();
    },
  );

  it("hands the box back at teardown (the claim is held, not leaked)", async () => {
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
    harnessState.finalText = EXTERNAL_ACCOUNT_PLAN_WALL_TEXTS[0]!;
    const onEngineError = vi.fn();
    await runHarnessTurn(baseOptions({ onEngineError }) as never, "none");
    expect(onEngineError).toHaveBeenCalledTimes(1);
    const err = onEngineError.mock.calls[0]![0] as { message: string };
    expect(err.message).toMatch(/didn't run the model/);
    expect(err.message).toContain("your organization's key");
  });

  it("does NOT fail a turn that merely quotes the wall text", async () => {
    harnessState.finalText = `The CLI said "${EXTERNAL_ACCOUNT_PLAN_WALL_TEXTS[0]}" — you may need a different plan.`;
    const onEngineError = vi.fn();
    await runHarnessTurn(baseOptions({ onEngineError }) as never, "none");
    expect(onEngineError).not.toHaveBeenCalled();
  });
});

describe("runHarnessTurn — the CLI's vendor tokens leave the box", () => {
  it("at the end of a turn that succeeded", async () => {
    await runHarnessTurn(baseOptions() as never, "none");
    expect(loginState.install).toHaveBeenCalledTimes(1);
    expect(loginState.clear).toHaveBeenCalledTimes(1);
  });

  it("at the end of a turn that failed", async () => {
    harnessState.finalText = EXTERNAL_ACCOUNT_PLAN_WALL_TEXTS[0]!;
    await runHarnessTurn(
      baseOptions({ onEngineError: vi.fn() }) as never,
      "none",
    );
    expect(loginState.clear).toHaveBeenCalledTimes(1);
  });

  it("cleans up an installation whose response failed", async () => {
    loginState.install.mockRejectedValueOnce(new Error("connection lost"));
    const onEngineError = vi.fn();
    await runHarnessTurn(baseOptions({ onEngineError }) as never, "none");
    expect(onEngineError).toHaveBeenCalled();
    expect(loginState.clear).toHaveBeenCalledTimes(1);
  });

  it("when the session never came up after the box opened", async () => {
    harnessState.createSessionError = new Error("session/new failed");
    const onEngineError = vi.fn();
    await runHarnessTurn(baseOptions({ onEngineError }) as never, "none");
    expect(onEngineError).toHaveBeenCalled();
    expect(loginState.clear).toHaveBeenCalledTimes(1);
  });
});

describe("credential cleanup failure", () => {
  it("destroys the session and releases its reservation when clearing fails", async () => {
    loginState.clear.mockRejectedValueOnce(
      new Error("Cursor login cleanup could not be confirmed."),
    );
    const onEngineError = vi.fn();
    await runHarnessTurn(baseOptions({ onEngineError }) as never, "none");
    expect(harnessState.session.destroy).toHaveBeenCalledTimes(1);
    expect(releaseHarnessBoxReservation).toHaveBeenCalledTimes(1);
    expect(onEngineError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("cleanup") }),
    );
  });

  it("still releases a failed startup when clearing also fails", async () => {
    loginState.install.mockRejectedValueOnce(new Error("install failed"));
    loginState.clear.mockRejectedValueOnce(
      new Error("Cursor login cleanup could not be confirmed."),
    );
    const onEngineError = vi.fn();
    await runHarnessTurn(baseOptions({ onEngineError }) as never, "none");
    expect(releaseHarnessBoxReservation).toHaveBeenCalledTimes(1);
    expect(onEngineError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("cleanup") }),
    );
  });
});
