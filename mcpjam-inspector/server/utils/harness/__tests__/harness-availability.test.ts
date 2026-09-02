import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkHarnessRuntimeAvailable,
  harnessModelEligibleForRuntime,
  harnessToolApprovalRefusalReason,
} from "../harness-availability";
import { registeredHarnessIds } from "../registry";
import { getHarnessAdapter, type HarnessId } from "../registry";

// The capability-driven preflight that lets the chat-v2 routes fail closed with a
// clear message when a harness host (claude-code | codex) can't run on this server.

const ENV_KEYS = [
  "CONVEX_HTTP_URL",
  "INSPECTOR_SERVICE_TOKEN",
  "COMPUTERS_TERMINAL_TOKEN_SECRET",
  "E2B_API_KEY",
  "MCPJAM_HARNESS_BROKER_DELIVERY",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function setFullyAvailable() {
  // Model credential is NOT an env var anymore (resolved from Convex per turn);
  // the preflight only checks the computers data plane + capability gates.
  process.env.CONVEX_HTTP_URL = "https://convex.example.com";
  process.env.INSPECTOR_SERVICE_TOKEN = "test-svc-token";
  process.env.COMPUTERS_TERMINAL_TOKEN_SECRET = "terminal-secret-16+";
  process.env.E2B_API_KEY = "e2b-test";
}

/** Default args: a fully-runnable harness host (no approval, no servers, eligible). */
function args(
  overrides: Partial<Parameters<typeof checkHarnessRuntimeAvailable>[0]> = {},
) {
  return {
    harnessId: "claude-code" as HarnessId,
    requireToolApproval: false,
    hasSelectedMcpServers: false,
    // The RESOLVED model. Eligibility and the canonical id are derived from it
    // INSIDE the gate, so a test cannot assert a combination the production
    // call sites could not produce.
    model: { id: "anthropic/claude-haiku-4.5", provider: "anthropic" },
    ...overrides,
  };
}

describe("checkHarnessRuntimeAvailable", () => {
  it.each([
    ["claude-code", "anthropic/claude-haiku-4.5"],
    ["codex", "openai/gpt-5-nano"],
  ] as const)(
    "is ok for %s when the data plane is configured and gates pass",
    (harnessId, modelId) => {
      setFullyAvailable();
      expect(
        checkHarnessRuntimeAvailable(
          args({ harnessId, model: { id: modelId } }),
        ),
      ).toEqual({ ok: true });
    },
  );

  // The harness reaches MCP servers through the signed-proxy route, whose
  // Convex-minted token carries {projectId, serverId} but no host — so that
  // route can't resolve or enforce the host's enterprise-managed policy. An
  // unregistered `auto` server would silently take the discover/OAuth path,
  // bypassing enforcement. Fail closed here instead.
  it("rejects a harness turn on an enterprise-managed host (proxy can't carry the policy)", () => {
    setFullyAvailable();
    const result = checkHarnessRuntimeAvailable(
      args({ xaaEnterprisePolicyOn: true }),
    );
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain(
      "enterprise-managed host",
    );
  });

  it("allows a harness turn when the host has no enterprise policy", () => {
    setFullyAvailable();
    expect(
      checkHarnessRuntimeAvailable(args({ xaaEnterprisePolicyOn: false })),
    ).toEqual({ ok: true });
    // Absent flag behaves as off (pre-feature callers unchanged).
    expect(checkHarnessRuntimeAvailable(args())).toEqual({ ok: true });
  });

  it("rejects a model the runtime can't run (non-gpt-5 on Codex)", () => {
    setFullyAvailable();
    // MCPJam-provided but not Codex-mappable ⇒ rejected, not silently defaulted.
    const r = checkHarnessRuntimeAvailable(
      args({ harnessId: "codex", model: { id: "anthropic/claude-haiku-4.5" } }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/can't run this host's model/);
  });

  it("fails when the computers data plane is not configured", () => {
    setFullyAvailable();
    delete process.env.E2B_API_KEY;
    const r = checkHarnessRuntimeAvailable(args());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/computers data plane/);
  });

  it("allows an approval host on Claude Code (WS3: native tool approval)", () => {
    setFullyAvailable();
    const r = checkHarnessRuntimeAvailable(args({ requireToolApproval: true }));
    expect(r.ok).toBe(true);
  });

  // Claude Code's own MCP tools take the NATIVE arm of the delivery split, and
  // it declares no MCP-tool approval. `kind` is asserted alongside the copy on
  // purpose: eval admission branches on the kind, so a copy edit must not be
  // what decides whether this stays a refusal.
  // Was a refusal: Claude Code was believed unable to pause on MCP-server
  // tools. The adapter bridge's `canUseTool` gates them under "allow-reads",
  // so the whole combination is admissible now. The gate that would still
  // refuse a native harness without that capability is covered in
  // `harnessToolApprovalRefusalReason` below.
  it("admits an approval host WITH selected MCP servers on Claude Code", () => {
    setFullyAvailable();
    const r = checkHarnessRuntimeAvailable(
      args({
        harnessId: "claude-code",
        requireToolApproval: true,
        hasSelectedMcpServers: true,
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("still blocks an approval host on Codex (no native approval)", () => {
    setFullyAvailable();
    const r = checkHarnessRuntimeAvailable(
      args({ harnessId: "codex", requireToolApproval: true }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/tool approval/);
  });

  it("names the harness in its message (capability-driven, not hardcoded)", () => {
    setFullyAvailable();
    delete process.env.E2B_API_KEY;
    const r = checkHarnessRuntimeAvailable(args({ harnessId: "codex" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Codex harness/);
  });

  it("allows a Codex host with selected MCP servers (host-executed delivery)", () => {
    // COMP-39: this used to be the `mcp-servers` refusal, which blocked every
    // Codex host with a server attached — and therefore every Codex eval, since
    // an eval suite always has servers. Codex now gets those servers as
    // host-executed tools, so there is nothing left to refuse.
    setFullyAvailable();
    expect(
      checkHarnessRuntimeAvailable(
        args({
          harnessId: "codex",
          hasSelectedMcpServers: true,
          model: { id: "openai/gpt-5-nano", provider: "openai" },
        }),
      ),
    ).toEqual({ ok: true });
  });

  it("still blocks a Codex approval host with MCP servers (approval can't be honored)", () => {
    // Advertise = enforce: Codex's MCP tools run on MCPJam's server as
    // host-executed tools, and Codex declares no host-executed tool approval.
    // Delivering the servers must NOT quietly turn approval into a no-op.
    setFullyAvailable();
    const r = checkHarnessRuntimeAvailable(
      args({
        harnessId: "codex",
        hasSelectedMcpServers: true,
        requireToolApproval: true,
        model: { id: "openai/gpt-5-nano", provider: "openai" },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("tool-approval");
  });

  it("allows a Claude Code host with selected MCP servers (it delivers them)", () => {
    setFullyAvailable();
    expect(
      checkHarnessRuntimeAvailable(
        args({ harnessId: "claude-code", hasSelectedMcpServers: true }),
      ),
    ).toEqual({ ok: true });
  });

  it("fails closed when the model isn't harness-eligible (no silent emulated)", () => {
    setFullyAvailable();
    const r = checkHarnessRuntimeAvailable(
      args({ model: { id: "acme/private-llm", provider: "custom" } }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/MCPJam-provided models/);
  });

  // The gate derives eligibility itself precisely so this cannot be got wrong
  // per call site. A BARE hosted id only canonicalizes with its provider, so a
  // provider-blind caller used to read `gpt-5-nano` as non-hosted and refuse a
  // perfectly legitimate host — the mirror image of the BYOK model being
  // wrongly admitted. Both directions are pinned here.
  it("admits a BARE hosted model id when the provider resolves it", () => {
    setFullyAvailable();
    expect(
      checkHarnessRuntimeAvailable(
        args({
          harnessId: "codex",
          model: { id: "gpt-5-nano", provider: "openai" },
        }),
      ),
    ).toEqual({ ok: true });
  });

  // COMP-23: broker delivery is the ONLY credential path. The kill switch must
  // surface as a pre-stream unavailability (named flag in the reason), and the
  // default (unset) must be ON.
  it("fails closed when broker delivery is killed (MCPJAM_HARNESS_BROKER_DELIVERY=false)", () => {
    setFullyAvailable();
    process.env.MCPJAM_HARNESS_BROKER_DELIVERY = "false";
    const r = checkHarnessRuntimeAvailable(args());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/MCPJAM_HARNESS_BROKER_DELIVERY/);
  });

  it.each(["unset", "true"] as const)(
    "broker delivery %s ⇒ available (default-ON kill switch)",
    (mode) => {
      setFullyAvailable();
      if (mode === "unset") delete process.env.MCPJAM_HARNESS_BROKER_DELIVERY;
      else process.env.MCPJAM_HARNESS_BROKER_DELIVERY = "true";
      expect(checkHarnessRuntimeAvailable(args())).toEqual({ ok: true });
    },
  );

  describe("external-account harnesses skip the model + broker gates", () => {
    // Three checks below are about a credential MCPJam supplies and a model
    // MCPJam hosts. An external-account runtime has neither: Cursor
    // authenticates on the customer's own Cursor account and its adapter
    // passes NO model, so Cursor Auto picks one. Applying the brokered rules
    // would refuse every Cursor host — its own seeded model is the
    // deliberately-not-hosted `cursor/auto` sentinel.
    const cursorArgs = () =>
      args({
        harnessId: "cursor" as HarnessId,
        model: { id: "cursor/auto", provider: "cursor" },
      });

    it("is available on a model MCPJam does not host", () => {
      setFullyAvailable();
      expect(checkHarnessRuntimeAvailable(cursorArgs())).toEqual({ ok: true });
    });

    it("stays available with broker delivery killed (it has no broker)", () => {
      setFullyAvailable();
      process.env.MCPJAM_HARNESS_BROKER_DELIVERY = "false";
      expect(checkHarnessRuntimeAvailable(cursorArgs())).toEqual({ ok: true });
      // …while the brokered harness beside it is still refused, so this is a
      // targeted exemption and not a hole in the kill switch.
      const brokered = checkHarnessRuntimeAvailable(args());
      expect(brokered.ok).toBe(false);
    });

    it("still enforces the gates that DO apply to it", () => {
      setFullyAvailable();
      // Data plane: the CLI runs inside a computer, so this one is real.
      delete process.env.E2B_API_KEY;
      const noDataPlane = checkHarnessRuntimeAvailable(cursorArgs());
      expect(noDataPlane.ok).toBe(false);
      if (!noDataPlane.ok)
        expect(noDataPlane.kind).toBe("computers-unconfigured");

      setFullyAvailable();
      // Approval: `supportsMcpToolApproval` is false pending a live check, so
      // an approval host WITH servers is refused rather than run with some MCP
      // calls unapproved.
      const approvalWithServers = checkHarnessRuntimeAvailable(
        args({
          harnessId: "cursor" as HarnessId,
          model: { id: "cursor/auto", provider: "cursor" },
          requireToolApproval: true,
          hasSelectedMcpServers: true,
        }),
      );
      expect(approvalWithServers.ok).toBe(false);
      if (!approvalWithServers.ok)
        expect(approvalWithServers.kind).toBe("tool-approval");

      // …but approval WITHOUT servers is fine: the native surface does pause.
      expect(
        checkHarnessRuntimeAvailable(
          args({
            harnessId: "cursor" as HarnessId,
            model: { id: "cursor/auto", provider: "cursor" },
            requireToolApproval: true,
            hasSelectedMcpServers: false,
          }),
        ),
      ).toEqual({ ok: true });
    });

    it("refuses an external-account host that pins an ORDINARY model id", () => {
      // The exemption is not "no model rule applies", it is "a different one
      // does": the host must carry the runtime's sentinel. Cursor ignores
      // whatever id the host holds and picks its own model, so a host pinned to
      // `anthropic/claude-sonnet-4.5` would run Cursor Auto while the session
      // row, the trace and the eval metadata all named Sonnet as the model that
      // ran — the exact mis-attribution this whole change exists to stop, just
      // arriving from the host side instead of the browser's.
      setFullyAvailable();
      const r = checkHarnessRuntimeAvailable(
        args({
          harnessId: "cursor" as HarnessId,
          model: {
            id: "anthropic/claude-sonnet-4.5",
            provider: "anthropic",
          },
        }),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.kind).toBe("model-unsupported");
        // Names the id it found, so the owner can see what to reset.
        expect(r.reason).toContain("anthropic/claude-sonnet-4.5");
      }
    });

    it("does not exempt a BROKERED harness from the model gate", () => {
      // The exemption is keyed on `modelAccess`, not on "harness runs a CLI".
      setFullyAvailable();
      const r = checkHarnessRuntimeAvailable(
        args({ model: { id: "cursor/auto", provider: "cursor" } }),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe("model-not-hosted");
    });
  });
});

/**
 * The DISPATCH gate, which decides whether a turn runs on the real runtime or
 * silently falls back to the emulated engine.
 *
 * This must agree with the pre-flight above for every adapter. When they
 * disagree the product does not error — it approves the turn, runs a different
 * engine, and reports the harness's name over it. A wrong answer attributed to
 * the wrong runtime is worse than a failure, which is why this is asserted
 * against the pre-flight rather than on its own.
 */
describe("harnessModelEligibleForRuntime", () => {
  it("agrees with the pre-flight for every registered adapter", () => {
    setFullyAvailable();
    const cases: Array<{ modelId: string; provider: string }> = [
      { modelId: "anthropic/claude-haiku-4.5", provider: "anthropic" },
      { modelId: "openai/gpt-5-nano", provider: "openai" },
      // The external-account sentinel: deliberately NOT an MCPJam-hosted model.
      { modelId: "cursor/auto", provider: "cursor" },
      // Hosted, but not every runtime can run it.
      { modelId: "anthropic/claude-sonnet-4.5", provider: "anthropic" },
    ];
    for (const id of registeredHarnessIds()) {
      const adapter = getHarnessAdapter(id);
      for (const model of cases) {
        const eligible = harnessModelEligibleForRuntime({
          adapter,
          modelId: model.modelId,
          provider: model.provider,
        });
        const preflight = checkHarnessRuntimeAvailable(
          args({
            harnessId: id,
            model: { id: model.modelId, provider: model.provider },
          }),
        );
        // The pre-flight can refuse for reasons this helper does not model
        // (approval, data plane); restrict the comparison to the MODEL kinds.
        const preflightModelRefusal =
          !preflight.ok &&
          (preflight.kind === "model-not-hosted" ||
            preflight.kind === "model-unsupported");
        expect(eligible, `${id} / ${model.modelId}`).toBe(
          !preflightModelRefusal,
        );
      }
    }
  });

  it("lets an external-account harness run its non-hosted sentinel model", () => {
    // The regression that made the whole feature inert: `cursor/auto` fails the
    // hosted-model check, so the dispatch ran the emulated engine and called it
    // Cursor.
    expect(
      harnessModelEligibleForRuntime({
        adapter: getHarnessAdapter("cursor"),
        modelId: "cursor/auto",
        provider: "cursor",
      }),
    ).toBe(true);
  });

  it("refuses an ordinary model id on an EXTERNAL-ACCOUNT harness", () => {
    // The dispatch half of the rule above. Left `true`, this is what let a
    // mis-configured Cursor host run the real runtime and report an unrelated
    // model id as the one that ran.
    expect(
      harnessModelEligibleForRuntime({
        adapter: getHarnessAdapter("cursor"),
        modelId: "anthropic/claude-sonnet-4.5",
        provider: "anthropic",
      }),
    ).toBe(false);
  });

  it("still refuses a non-hosted model for a BROKERED harness", () => {
    // The exemption is keyed on `modelAccess`, not on "harness".
    expect(
      harnessModelEligibleForRuntime({
        adapter: getHarnessAdapter("claude-code"),
        modelId: "cursor/auto",
        provider: "cursor",
      }),
    ).toBe(false);
  });

  it("still refuses a hosted model the runtime cannot run", () => {
    expect(
      harnessModelEligibleForRuntime({
        adapter: getHarnessAdapter("codex"),
        modelId: "anthropic/claude-haiku-4.5",
        provider: "anthropic",
      }),
    ).toBe(false);
  });
});

/**
 * The approval rules as a standalone value, because `runHarnessTurn` re-asserts
 * them for the eval / synthetic / unified paths, which never reach the
 * pre-flight above. Two hand-copied conditions would drift; these assert the
 * matrix ONE function answers for both.
 */
describe("harnessToolApprovalRefusalReason", () => {
  const claudeCode = getHarnessAdapter("claude-code");
  const codex = getHarnessAdapter("codex");

  it.each([
    ["claude-code", false],
    ["claude-code", true],
    ["codex", false],
    ["codex", true],
  ] as const)(
    "%s with approval OFF is sound (servers attached: %s)",
    (harnessId, hasSelectedMcpServers) => {
      expect(
        harnessToolApprovalRefusalReason({
          adapter: getHarnessAdapter(harnessId),
          requireToolApproval: false,
          hasSelectedMcpServers,
        }),
      ).toBeUndefined();
    },
  );

  // The gap this closes: Codex's NATIVE tools can't pause either, and its
  // built-in host-executed tools (web_search) are not approval-gated because
  // `supportsHostExecutedToolApproval` is false. Conditioning the refusal on
  // there being MCP servers would let a zero-server eval run them unapproved.
  it("refuses Codex under approval even with NO servers selected", () => {
    expect(
      harnessToolApprovalRefusalReason({
        adapter: codex,
        requireToolApproval: true,
        hasSelectedMcpServers: false,
      }),
    ).toMatch(/doesn't support interactive tool approval/);
  });

  it("refuses Codex under approval with servers selected", () => {
    expect(
      harnessToolApprovalRefusalReason({
        adapter: codex,
        requireToolApproval: true,
        hasSelectedMcpServers: true,
      }),
    ).toBeDefined();
  });

  // Claude Code pauses on its own native tools (WS3), so approval alone is
  // fine.
  it("allows Claude Code under approval with no servers", () => {
    expect(
      harnessToolApprovalRefusalReason({
        adapter: claudeCode,
        requireToolApproval: true,
        hasSelectedMcpServers: false,
      }),
    ).toBeUndefined();
  });

  // It now pauses on its MCP tools too (the bridge's `canUseTool` under
  // "allow-reads"), so attaching a server no longer makes the combination
  // unsound. This used to be the refusal case.
  it("allows Claude Code under approval once a server is attached", () => {
    expect(claudeCode.mcpDelivery).toBe("native");
    expect(claudeCode.supportsMcpToolApproval).toBe(true);
    expect(
      harnessToolApprovalRefusalReason({
        adapter: claudeCode,
        requireToolApproval: true,
        hasSelectedMcpServers: true,
      }),
    ).toBeUndefined();
  });

  // The gate itself must still bite. Claude Code satisfying it is a fact about
  // the adapter, not a reason to stop checking: a NATIVE-delivery harness that
  // cannot pause on MCP tools is still refused the moment a server is attached.
  it("still refuses a native harness that can't approve its MCP tools", () => {
    const noMcpApproval = {
      ...claudeCode,
      supportsMcpToolApproval: false,
    } as typeof claudeCode;
    expect(
      harnessToolApprovalRefusalReason({
        adapter: noMcpApproval,
        requireToolApproval: true,
        hasSelectedMcpServers: true,
      }),
    ).toMatch(/MCP-server tools/);
    // …and only once a server is actually attached.
    expect(
      harnessToolApprovalRefusalReason({
        adapter: noMcpApproval,
        requireToolApproval: true,
        hasSelectedMcpServers: false,
      }),
    ).toBeUndefined();
  });

  // The bypass the delivery split exists to prevent: Codex's MCP tools are
  // host-executed, so reading `supportsMcpToolApproval` (irrelevant here, and
  // now TRUE on the other adapter) would have looked like the right check.
  it("reads the capability for the surface each adapter's MCP tools run on", () => {
    expect(codex.mcpDelivery).toBe("host-executed");
    expect(codex.supportsHostExecutedToolApproval).toBe(false);
    const stillApproves = {
      ...codex,
      supportsNativeToolApproval: true,
      supportsHostExecutedToolApproval: true,
      // Left false on purpose: under host-executed delivery this must not be
      // what the gate consults.
      supportsMcpToolApproval: false,
    } as typeof codex;
    expect(
      harnessToolApprovalRefusalReason({
        adapter: stillApproves,
        requireToolApproval: true,
        hasSelectedMcpServers: true,
      }),
    ).toBeUndefined();
  });
});
