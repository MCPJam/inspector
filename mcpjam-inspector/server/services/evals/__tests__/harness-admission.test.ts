import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkEvalHarnessAdmission,
  checkEvalHarnessStaticAdmission,
  executionEngineLabel,
  harnessOfHostConfig,
} from "../harness-admission";

/**
 * The gate that stops a harness-hosted eval run from silently executing on the
 * emulated engine and reporting green. See `harness-admission.ts` for why the
 * shared `checkHarnessRuntimeAvailable` is CALLED rather than re-derived.
 */

const ENV_KEYS = [
  "CONVEX_HTTP_URL",
  "INSPECTOR_SERVICE_TOKEN",
  "COMPUTERS_TERMINAL_TOKEN_SECRET",
  "E2B_API_KEY",
  "MCPJAM_HARNESS_BROKER_DELIVERY",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  // A server on which the harness runtime IS available, so every refusal below
  // is attributable to the configuration under test rather than the fixture.
  process.env.CONVEX_HTTP_URL = "https://convex.example.com";
  process.env.INSPECTOR_SERVICE_TOKEN = "test-svc-token";
  process.env.COMPUTERS_TERMINAL_TOKEN_SECRET = "terminal-secret-16+";
  process.env.E2B_API_KEY = "e2b-test";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const HOSTED_MODEL = {
  model: "anthropic/claude-haiku-4.5",
  provider: "anthropic",
};
const BYOK_MODEL = { model: "some-local-model", provider: "ollama" };

function harnessHost(extra: Record<string, unknown> = {}) {
  return { harness: "claude-code", ...extra };
}

describe("checkEvalHarnessAdmission", () => {
  it("admits a non-harness host untouched — the overwhelmingly common case", () => {
    expect(
      checkEvalHarnessAdmission({
        hostConfig: { hostStyle: "mcpjam" },
        serverIds: ["s1"],
        cases: [{ title: "a", ...HOSTED_MODEL }],
      })
    ).toEqual({ ok: true });

    // Null host config (a suite that never wrote one) is emulated, not harness.
    expect(checkEvalHarnessAdmission({ hostConfig: null, cases: [] })).toEqual({
      ok: true,
    });
  });

  it("REFUSES a harness host rather than degrading to emulated", () => {
    const verdict = checkEvalHarnessAdmission({
      hostConfig: harnessHost(),
      serverIds: ["s1"],
      cases: [{ title: "a", ...HOSTED_MODEL }],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.harness).toBe("claude-code");
    expect(verdict.reason).toContain("cannot execute the Claude Code harness");
  });

  it("names the INELIGIBLE CASES when a suite mixes hosted and BYOK models", () => {
    const verdict = checkEvalHarnessAdmission({
      hostConfig: harnessHost(),
      serverIds: ["s1"],
      cases: [
        { title: "hosted case", ...HOSTED_MODEL },
        { title: "byok case", ...BYOK_MODEL },
      ],
      // Even with execution allowed, an ineligible model must fail — it routes
      // through the direct engine, which never forwards a harness.
      allowHarnessExecution: true,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toContain("only runs MCPJam-provided models");
    expect(verdict.reason).toContain("byok case");
    expect(verdict.reason).not.toContain("hosted case");
  });

  it("reports a HOST-level refusal once, not per case", () => {
    const verdict = checkEvalHarnessAdmission({
      hostConfig: harnessHost({ requireToolApproval: true }),
      serverIds: ["s1"],
      cases: [
        { title: "one", ...HOSTED_MODEL },
        { title: "two", ...HOSTED_MODEL },
      ],
      allowHarnessExecution: true,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toContain("approval");
    expect(verdict.reason).not.toContain("Ineligible cases");
  });

  it("does not gate MODEL-FREE cases on model eligibility", () => {
    // The recorder emits `widget-probe`/`none` sentinels for pinned-only cases.
    // They never reach a model runtime, so refusing the suite over them would
    // reject a configuration it does not actually use.
    const verdict = checkEvalHarnessAdmission({
      hostConfig: harnessHost(),
      serverIds: ["s1"],
      cases: [{ title: "probe", model: "widget-probe", provider: "none" }],
      allowHarnessExecution: true,
    });
    expect(verdict).toEqual({ ok: true, harness: "claude-code" });
  });

  it("admits an eligible harness host once execution is allowed", () => {
    expect(
      checkEvalHarnessAdmission({
        hostConfig: harnessHost(),
        serverIds: ["s1"],
        cases: [{ title: "a", ...HOSTED_MODEL }],
        allowHarnessExecution: true,
      })
    ).toEqual({ ok: true, harness: "claude-code" });
  });

  it("refuses when broker delivery is switched off, with the gate's own reason", () => {
    process.env.MCPJAM_HARNESS_BROKER_DELIVERY = "false";
    const verdict = checkEvalHarnessAdmission({
      hostConfig: harnessHost(),
      serverIds: ["s1"],
      cases: [{ title: "a", ...HOSTED_MODEL }],
      allowHarnessExecution: true,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toContain("broker");
  });

  it("refuses a harness that cannot deliver the suite's MCP servers", () => {
    // An eval suite ALWAYS has servers, so Codex (supportsSelectedMcpServers:
    // false) can never run one — surfaced as the gate's reason, not as a
    // half-configured run.
    const verdict = checkEvalHarnessAdmission({
      hostConfig: { harness: "codex" },
      serverIds: ["s1"],
      cases: [{ title: "a", model: "openai/gpt-5", provider: "openai" }],
      allowHarnessExecution: true,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toContain("MCP servers");
  });
});

describe("checkEvalHarnessStaticAdmission", () => {
  it("decides host-level rules with no cases at all — what batch dry-run needs", () => {
    expect(
      checkEvalHarnessStaticAdmission({
        hostConfig: { hostStyle: "mcpjam" },
        serverIds: ["s1"],
      })
    ).toEqual({ ok: true });

    const approvalHost = checkEvalHarnessStaticAdmission({
      hostConfig: harnessHost({ requireToolApproval: true }),
      serverIds: ["s1"],
      allowHarnessExecution: true,
    });
    expect(approvalHost.ok).toBe(false);
  });

  it("does NOT refuse on model eligibility when the host pins no model", () => {
    // With no host-pinned model the probe id is empty, which is not evidence
    // about any model the caller configured. The full check owns that call.
    const verdict = checkEvalHarnessStaticAdmission({
      hostConfig: harnessHost(),
      serverIds: ["s1"],
      allowHarnessExecution: true,
    });
    expect(verdict).toEqual({ ok: true, harness: "claude-code" });
  });

  it("refuses a host-pinned model the harness cannot run", () => {
    const verdict = checkEvalHarnessStaticAdmission({
      hostConfig: harnessHost({ modelId: "ollama/llama3" }),
      serverIds: ["s1"],
      allowHarnessExecution: true,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toContain("MCPJam-provided models");
  });

  it("counts PLUGIN-contributed servers toward the MCP gate", () => {
    // A host whose servers come solely from a plugin would otherwise slip the
    // rule the gate exists to enforce.
    const verdict = checkEvalHarnessStaticAdmission({
      hostConfig: { harness: "codex" },
      serverIds: [],
      pluginServerIds: ["plugin-server-1"],
      allowHarnessExecution: true,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toContain("MCP servers");
  });
});

describe("attribution helpers", () => {
  it("reads only a REGISTERED harness id off a host config", () => {
    expect(harnessOfHostConfig({ harness: "claude-code" })).toBe("claude-code");
    expect(harnessOfHostConfig({ harness: "not-a-harness" })).toBeUndefined();
    expect(harnessOfHostConfig(null)).toBeUndefined();
  });

  it("labels the engine the run executes on", () => {
    expect(executionEngineLabel({ harness: "claude-code" })).toBe(
      "harness:claude-code"
    );
    expect(executionEngineLabel({ hostStyle: "mcpjam" })).toBe("emulated");
    expect(executionEngineLabel(null)).toBe("emulated");
  });
});
