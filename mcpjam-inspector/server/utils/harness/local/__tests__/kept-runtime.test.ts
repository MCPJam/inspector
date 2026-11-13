import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keptLocalRuntimeTurn, keptRuntimeFingerprint } from "../kept-runtime.js";

const configuration = {
  runtime: "codex|openai/gpt-5.5|abc123",
  reasoningEffort: "medium",
  skillsHash: "skills-1",
  systemPrompt: "You are Codex.",
  requireToolApproval: true,
  env: {},
};

const committed = {
  stateVersion: 4,
  state: { resumeState: { type: "resume-session", data: { bridge: { port: 4100, token: "gen-1" } } } },
};

function request(overrides: Partial<Parameters<typeof keptLocalRuntimeTurn>[0]> = {}) {
  return keptLocalRuntimeTurn({
    harnessId: "codex",
    ownerType: "direct-chat",
    isApprovalResume: false,
    continuity: committed,
    configuration,
    ...overrides,
  });
}

beforeEach(() => vi.stubEnv("MCPJAM_LOCAL_KEEP_AGENT", "true"));
afterEach(() => vi.unstubAllEnvs());

describe("what a local turn asks for", () => {
  it("is nothing while the switch is off", () => {
    vi.stubEnv("MCPJAM_LOCAL_KEEP_AGENT", "");
    expect(request()).toBeUndefined();
    vi.stubEnv("MCPJAM_LOCAL_KEEP_AGENT", "1");
    expect(request()).toBeUndefined();
  });

  it("is Codex in a member's own chat only, never an approval continuation", () => {
    // Read from each runtime's definition (`keptBetweenTurns`).
    expect(request({ harnessId: "claude-code" })).toBeUndefined();
    expect(request({ harnessId: "copilot-cli" })).toBeUndefined();
    expect(request({ harnessId: "cursor" })).toBeUndefined();
    expect(request({ ownerType: "swarm-chat" })).toBeUndefined();
    expect(request({ ownerType: undefined })).toBeUndefined();
    expect(request({ isApprovalResume: true })).toBeUndefined();
  });

  it("names the runtime the lane's committed state names, by bridge token and state version", () => {
    expect(request()).toEqual({
      fingerprint: keptRuntimeFingerprint(configuration),
      committed: { generation: "gen-1", stateVersion: 4 },
    });
  });

  it("asks to keep this turn's runtime even when the lane names none", () => {
    expect(request({ continuity: undefined })).toEqual({ fingerprint: keptRuntimeFingerprint(configuration) });
    expect(request({ continuity: { stateVersion: 0, state: null } })).toEqual({ fingerprint: keptRuntimeFingerprint(configuration) });
  });
});

describe("the configuration a kept runtime must match", () => {
  it.each([
    ["the runtime fingerprint (model, servers, permission mode, plugins, secrets, target, key)", { runtime: "codex|openai/gpt-5.4|abc123" }],
    ["the reasoning effort", { reasoningEffort: "high" }],
    ["the skills", { skillsHash: "skills-2" }],
    ["the system prompt", { systemPrompt: "You are a reviewer." }],
    ["the Tool Approval setting", { requireToolApproval: false }],
    ["the environment", { env: { STRIPE_API_KEY: "sk_live_x" } }],
  ])("changes with %s", (_label, change) => {
    expect(keptRuntimeFingerprint({ ...configuration, ...change })).not.toBe(keptRuntimeFingerprint(configuration));
  });

  it("is stable, ignores the environment's order, and never contains a value", () => {
    const a = keptRuntimeFingerprint({ ...configuration, env: { A: "secret-one", B: "secret-two" } });
    const b = keptRuntimeFingerprint({ ...configuration, env: { B: "secret-two", A: "secret-one" } });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain("secret");
  });
});
