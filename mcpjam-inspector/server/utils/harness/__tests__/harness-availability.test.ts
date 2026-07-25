import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkHarnessRuntimeAvailable } from "../harness-availability";
import type { HarnessId } from "../registry";

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
  overrides: Partial<Parameters<typeof checkHarnessRuntimeAvailable>[0]> = {}
) {
  return {
    harnessId: "claude-code" as HarnessId,
    requireToolApproval: false,
    hasSelectedMcpServers: false,
    modelEligible: true,
    // A model each default harness can run: anthropic for claude-code; the
    // codex cases below override with a gpt-5 model.
    modelId: "anthropic/claude-haiku-4.5",
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
        checkHarnessRuntimeAvailable(args({ harnessId, modelId }))
      ).toEqual({ ok: true });
    }
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
      args({ harnessId: "codex", modelId: "anthropic/claude-haiku-4.5" })
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

  it("still blocks an approval host WITH selected MCP servers (no MCP approval knob)", () => {
    setFullyAvailable();
    const r = checkHarnessRuntimeAvailable(
      args({ requireToolApproval: true, hasSelectedMcpServers: true })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/MCP-server tools/);
  });

  it("still blocks an approval host on Codex (no native approval)", () => {
    setFullyAvailable();
    const r = checkHarnessRuntimeAvailable(
      args({ harnessId: "codex", requireToolApproval: true })
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

  it("blocks a Codex host that has selected MCP servers (v1: no MCP)", () => {
    setFullyAvailable();
    const r = checkHarnessRuntimeAvailable(
      args({ harnessId: "codex", hasSelectedMcpServers: true })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/doesn't support MCP servers/);
  });

  it("allows a Claude Code host with selected MCP servers (it delivers them)", () => {
    setFullyAvailable();
    expect(
      checkHarnessRuntimeAvailable(
        args({ harnessId: "claude-code", hasSelectedMcpServers: true })
      )
    ).toEqual({ ok: true });
  });

  it("fails closed when the model isn't harness-eligible (no silent emulated)", () => {
    setFullyAvailable();
    const r = checkHarnessRuntimeAvailable(args({ modelEligible: false }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/MCPJam-provided models/);
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
    }
  );
});
