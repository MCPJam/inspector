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
    externalAccountBrokerBinding: {
      CURSOR_API_KEY: {
        hosts: ["api2.cursor.sh"],
        header: "authorization",
        template: "Bearer {}",
      },
    },
    mcpDelivery: "native",
    mcpNativeDelivery: "session-config",
    // Never consulted on this path — declared so a regression that starts
    // consulting it is visible rather than silently permissive.
    supportsModel: vi.fn(() => false),
    createHarness: registryState.createHarness,
    parseToolName: vi.fn((toolName: string) => ({ toolName })),
  })),
}));

/**
 * The BROKERED delivery lookup. Metadata only — there is no function here that
 * could return a brokered value, because there is none in the real client
 * either: a brokered plaintext never enters this process.
 */
const secretsClientState = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  /** What the run's ENVIRONMENT grants — the boundary the brokered check is
   *  scoped to. Defaults (in `beforeEach`) to granting the Cursor row. */
  selection: [] as string[],
}));

vi.mock("../../computers/convex-secrets-client.js", () => ({
  convexListProjectSecretBindings: vi.fn(async () => secretsClientState.rows),
  convexGetEnvironmentSecretSelection: vi.fn(
    async () => secretsClientState.selection,
  ),
  convexListSecretsForRuntimeExecution: vi.fn(async () => []),
  convexMarkSecretsDelivered: vi.fn(async () => ({ marked: 0 })),
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
    // The run's Project Environment — the GRANT BOUNDARY. Every hosted surface
    // that can run a Cursor host threads one (chat via `web-chat-turn`, swarm
    // via the pinned target's `environmentRef`, eval via the run's
    // `configSnapshot.environmentRef`), so the default here matches them.
    environmentId: "env-1",
    runtimeSecrets: [CURSOR_KEY, OTHER_SECRET],
    ...overrides,
  };
}

beforeEach(() => {
  harnessState.finalText = "done";
  providerState.lastArgs = undefined;
  secretsClientState.rows = [];
  secretsClientState.selection = [CURSOR_SECRET_ROW_ID];
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

/**
 * The BROKERED arm. The turn accepts a credential it never sees: the backend
 * composes the project secret into the box's E2B egress transform, and the box
 * carries a placeholder the proxy overwrites on the way out of the VM.
 *
 * This is the delivery hosted evals and swarms accept — they refuse an
 * environment that selects MATERIALIZED secrets outright (`evalSandboxes.ts`,
 * `journeyRuns.ts`), so before this arm existed a Cursor host could not run on
 * those surfaces in any configuration at all.
 */
const EPHEMERAL_BINDING = {
  sandboxRowId: "sbxrow_1",
  sandboxId: "e2b_ephemeral_1",
  workdir: "/home/user/work",
};

const CURSOR_SECRET_ROW_ID = "secret-cursor";

const BROKERED_CURSOR_ROW = {
  secretId: CURSOR_SECRET_ROW_ID,
  name: "CURSOR_API_KEY",
  delivery: "brokered",
  brokerHosts: ["api2.cursor.sh"],
  brokerHeader: "authorization",
  brokerTemplate: "Bearer {}",
};

describe("runHarnessTurn — external-account BROKERED credential", () => {
  it("runs with no materialized secret, handing the adapter a placeholder", async () => {
    secretsClientState.rows = [BROKERED_CURSOR_ROW];
    const onEngineError = vi.fn();
    await runHarnessTurn(
      baseOptions({
        runtimeSecrets: undefined,
        harnessSandboxBinding: EPHEMERAL_BINDING,
        onEngineError,
      }) as never,
      "none",
    );

    expect(onEngineError).not.toHaveBeenCalled();
    const args = registryState.createHarness.mock.calls[0]![0] as unknown as {
      auth: Record<string, string>;
    };
    // The REAL key is not here and cannot be: nothing in this process ever
    // fetched it. What the CLI sends is overwritten outside the VM.
    expect(args.auth.CURSOR_API_KEY).toBe("mcpjam-brokered-credential");
    expect(args.auth.CURSOR_API_KEY).not.toContain("key_live");
    // Still no lease — external-account means MCPJam brokers no MODEL access.
    expect(startHarnessModelBroker).not.toHaveBeenCalled();
  });

  it("does NOT stamp delivery for a brokered credential", async () => {
    // `lastDeliveredAt` answers "did anything receive this from us". On this arm
    // the answer is no: the backend delivered it into the egress transform.
    secretsClientState.rows = [BROKERED_CURSOR_ROW];
    const onSecretEnvDelivered = vi.fn();
    await runHarnessTurn(
      baseOptions({
        runtimeSecrets: undefined,
        harnessSandboxBinding: EPHEMERAL_BINDING,
        onSecretEnvDelivered,
      }) as never,
      "none",
    );
    expect(onSecretEnvDelivered).not.toHaveBeenCalled();
  });

  it("still stamps delivery when the credential is MATERIALIZED", async () => {
    secretsClientState.rows = [BROKERED_CURSOR_ROW];
    const onSecretEnvDelivered = vi.fn();
    await runHarnessTurn(
      baseOptions({
        runtimeSecrets: [CURSOR_KEY],
        harnessSandboxBinding: EPHEMERAL_BINDING,
        onSecretEnvDelivered,
      }) as never,
      "none",
    );
    expect(onSecretEnvDelivered).toHaveBeenCalled();
    const args = registryState.createHarness.mock.calls[0]![0] as unknown as {
      auth: Record<string, string>;
    };
    // Materialized WINS when both are configured: it is the delivery this
    // process can prove reached the box.
    expect(args.auth.CURSOR_API_KEY).toBe(CURSOR_KEY.value);
  });

  it("keeps the placeholder out of the box's session env bag", async () => {
    secretsClientState.rows = [BROKERED_CURSOR_ROW];
    await runHarnessTurn(
      baseOptions({
        runtimeSecrets: [OTHER_SECRET],
        harnessSandboxBinding: EPHEMERAL_BINDING,
      }) as never,
      "none",
    );
    const sessionEnv = providerState.lastArgs?.sessionEnv as
      | Record<string, string>
      | undefined;
    expect(sessionEnv).not.toHaveProperty("CURSOR_API_KEY");
    expect(sessionEnv).toHaveProperty("STRIPE_API_KEY", OTHER_SECRET.value);
  });

  it("refuses a brokered-only credential on a PERSISTENT computer", async () => {
    // `listBrokeredSecretsForBox` answers `[]` for any box with no sandbox row,
    // so this box will never carry the transform — starting it would send a
    // placeholder to the vendor.
    secretsClientState.rows = [BROKERED_CURSOR_ROW];
    const onEngineError = vi.fn();
    await runHarnessTurn(
      baseOptions({ runtimeSecrets: undefined, onEngineError }) as never,
      "none",
    );
    expect(onEngineError).toHaveBeenCalledTimes(1);
    expect(registryState.createHarness).not.toHaveBeenCalled();
  });

  it("refuses a correctly bound row the run's ENVIRONMENT does not select", async () => {
    // The turn-level proof for the scoping fix. The project holds a brokered
    // CURSOR_API_KEY bound exactly right, but this run's environment does not
    // grant it, so `listBrokeredSecretsForBox` composes nothing onto the box.
    // Before scoping, this STARTED the turn and failed vendor auth after the
    // box was provisioned; now nothing is provisioned at all.
    secretsClientState.rows = [BROKERED_CURSOR_ROW];
    secretsClientState.selection = ["secret-something-else"];
    const onEngineError = vi.fn();
    await runHarnessTurn(
      baseOptions({
        runtimeSecrets: undefined,
        harnessSandboxBinding: EPHEMERAL_BINDING,
        onEngineError,
      }) as never,
      "none",
    );
    expect(onEngineError).toHaveBeenCalledTimes(1);
    const err = onEngineError.mock.calls[0]![0] as { message: string };
    expect(err.message).toContain("CURSOR_API_KEY");
    expect(err.message).toMatch(/does not select it/i);
    expect(registryState.createHarness).not.toHaveBeenCalled();
    expect(reserveHarnessBox).not.toHaveBeenCalled();
  });

  it("refuses when the turn resolved no environment at all", async () => {
    secretsClientState.rows = [BROKERED_CURSOR_ROW];
    const onEngineError = vi.fn();
    await runHarnessTurn(
      baseOptions({
        runtimeSecrets: undefined,
        environmentId: undefined,
        harnessSandboxBinding: EPHEMERAL_BINDING,
        onEngineError,
      }) as never,
      "none",
    );
    expect(onEngineError).toHaveBeenCalledTimes(1);
    const err = onEngineError.mock.calls[0]![0] as { message: string };
    expect(err.message).toMatch(/no Project Environment/i);
    expect(registryState.createHarness).not.toHaveBeenCalled();
  });

  it("blames the REPLAY path, not the reader, when it cannot name the environment", async () => {
    // A replay run inherits the source run's environmentRef on the backend, so
    // its box may really carry the transform — this process just cannot read
    // that ref back. Still refused (an unverifiable grant is not a grant), but
    // the copy must not send the reader to change a correct configuration.
    secretsClientState.rows = [BROKERED_CURSOR_ROW];
    const onEngineError = vi.fn();
    await runHarnessTurn(
      baseOptions({
        runtimeSecrets: undefined,
        environmentId: undefined,
        environmentUnresolvedReason:
          "replaying a run does not carry the original run's Project " +
          "Environment through to the runner.",
        harnessSandboxBinding: EPHEMERAL_BINDING,
        onEngineError,
      }) as never,
      "none",
    );
    expect(onEngineError).toHaveBeenCalledTimes(1);
    const err = onEngineError.mock.calls[0]![0] as { message: string };
    expect(err.message).toContain("replaying a run");
    expect(err.message).not.toMatch(/no Project Environment/i);
    expect(err.message).not.toMatch(/does not select it/i);
    expect(registryState.createHarness).not.toHaveBeenCalled();
    expect(reserveHarnessBox).not.toHaveBeenCalled();
  });

  it("ignores a stale unresolved reason once the environment IS known", async () => {
    // Belt and braces: a caller that sets both must not turn a real
    // selection failure into "MCPJam could not tell".
    secretsClientState.rows = [BROKERED_CURSOR_ROW];
    secretsClientState.selection = ["secret-something-else"];
    const onEngineError = vi.fn();
    await runHarnessTurn(
      baseOptions({
        runtimeSecrets: undefined,
        environmentUnresolvedReason: "should be ignored",
        harnessSandboxBinding: EPHEMERAL_BINDING,
        onEngineError,
      }) as never,
      "none",
    );
    const err = onEngineError.mock.calls[0]![0] as { message: string };
    expect(err.message).toMatch(/does not select it/i);
    expect(err.message).not.toContain("should be ignored");
  });

  it("refuses when the brokered row is bound to the wrong host", async () => {
    secretsClientState.rows = [
      { ...BROKERED_CURSOR_ROW, brokerHosts: ["api.example.com"] },
    ];
    const onEngineError = vi.fn();
    await runHarnessTurn(
      baseOptions({
        runtimeSecrets: undefined,
        harnessSandboxBinding: EPHEMERAL_BINDING,
        onEngineError,
      }) as never,
      "none",
    );
    expect(onEngineError).toHaveBeenCalledTimes(1);
    const err = onEngineError.mock.calls[0]![0] as { message: string };
    expect(err.message).toContain("api2.cursor.sh");
    expect(registryState.createHarness).not.toHaveBeenCalled();
  });

  it("names BOTH deliveries when neither is configured", async () => {
    const onEngineError = vi.fn();
    await runHarnessTurn(
      baseOptions({
        runtimeSecrets: undefined,
        harnessSandboxBinding: EPHEMERAL_BINDING,
        onEngineError,
      }) as never,
      "none",
    );
    const err = onEngineError.mock.calls[0]![0] as { message: string };
    expect(err.message).toContain("CURSOR_API_KEY");
    expect(err.message).toMatch(/brokered/i);
    expect(err.message).toMatch(/materialized/i);
  });
});
