import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkHarnessRuntimeAvailable } from "../harness-availability";
import type { HarnessId } from "../registry";

// The capability-driven preflight that lets the chat-v2 routes fail closed with a
// clear message when a harness host (claude-code | codex) can't run on this server.

const ENV_KEYS = [
  "CONVEX_HTTP_URL",
  "COMPUTERS_DATA_PLANE_SECRET",
  "E2B_API_KEY",
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
  process.env.COMPUTERS_DATA_PLANE_SECRET = "secret";
  process.env.E2B_API_KEY = "e2b-test";
}

/** Default args: a fully-runnable harness host (no approval, no servers, eligible). */
function args(overrides: Partial<Parameters<typeof checkHarnessRuntimeAvailable>[0]> = {}) {
  return {
    harnessId: "claude-code" as HarnessId,
    requireToolApproval: false,
    hasSelectedMcpServers: false,
    modelEligible: true,
    ...overrides,
  };
}

describe("checkHarnessRuntimeAvailable", () => {
  it.each(["claude-code", "codex"] as const)(
    "is ok for %s when the data plane is configured and gates pass",
    (harnessId) => {
      setFullyAvailable();
      expect(checkHarnessRuntimeAvailable(args({ harnessId }))).toEqual({
        ok: true,
      });
    },
  );

  it("fails when the computers data plane is not configured", () => {
    setFullyAvailable();
    delete process.env.E2B_API_KEY;
    const r = checkHarnessRuntimeAvailable(args());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/computers data plane/);
  });

  it("fails when the host requires interactive tool approval", () => {
    setFullyAvailable();
    const r = checkHarnessRuntimeAvailable(args({ requireToolApproval: true }));
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
      args({ harnessId: "codex", hasSelectedMcpServers: true }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/doesn't support MCP servers/);
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
    const r = checkHarnessRuntimeAvailable(args({ modelEligible: false }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/MCPJam-provided models/);
  });
});
