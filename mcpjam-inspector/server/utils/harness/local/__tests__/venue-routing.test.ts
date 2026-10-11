import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  enabled: true, hosted: false, pack: true, conformance: "tested", codexConformance: "",
  codexTargets: ["darwin-arm64"] as string[] | undefined,
  codexSandboxTargets: [] as string[] | undefined, rollout: vi.fn(),
}));
vi.mock("../../../../config.js", () => ({ get HOSTED_MODE() { return state.hosted; }, get LOCAL_HARNESS_ENABLED() { return state.enabled; } }));
vi.mock("../runtime-install.js", () => ({ expectedPackFor: () => state.pack ? {} : null }));
vi.mock("../targets.js", () => ({ localPackTarget: () => "darwin-arm64", SUPPORTED_LOCAL_HARNESS_IDS: ["claude-code", "codex"] }));
vi.mock("../availability.js", () => ({
  localHarnessManifestsForDevelopment: () => ({
    "claude-code": { lifecycleConformanceVersion: state.conformance },
    codex: {
      lifecycleConformanceVersion: state.codexConformance,
      nativeTargets: state.codexTargets,
      unattendedSandboxTargets: state.codexSandboxTargets,
    },
  }),
}));
vi.mock("../readiness.js", () => ({ ensureLocalHarnessTarget: vi.fn(), localHarnessAccountEnabled: state.rollout }));
import { shouldUseLocalHarness } from "../run-resources.js";
beforeEach(() => {
  state.enabled = true; state.hosted = false; state.pack = true; state.conformance = "tested";
  state.codexConformance = ""; state.codexTargets = ["darwin-arm64"]; state.codexSandboxTargets = [];
  state.rollout.mockReset().mockResolvedValue(true);
});
it("requires every local eligibility gate and preserves cloud selection otherwise", async () => {
  expect(await shouldUseLocalHarness("claude-code", "bearer", "project")).toBe(true);
  expect(state.rollout).toHaveBeenCalledWith("bearer", "project", "claude-code");
  state.enabled = false; expect(await shouldUseLocalHarness("claude-code")).toBe(false); state.enabled = true;
  state.pack = false; expect(await shouldUseLocalHarness("claude-code")).toBe(false); state.pack = true;
  state.conformance = ""; expect(await shouldUseLocalHarness("claude-code")).toBe(false); state.conformance = "tested";
  state.hosted = true; expect(await shouldUseLocalHarness("claude-code")).toBe(false); state.hosted = false;
  state.rollout.mockResolvedValue(false); expect(await shouldUseLocalHarness("claude-code")).toBe(false);
});
it("keeps Codex hosted until its own conformance, target and rollout gates all pass", async () => {
  // Dark: no Codex conformance recorded, so not even the account is asked.
  expect(await shouldUseLocalHarness("codex", "bearer", "project")).toBe(false);
  expect(state.rollout).not.toHaveBeenCalled();
  state.codexConformance = "tested";
  expect(await shouldUseLocalHarness("codex", "bearer", "project")).toBe(true);
  // Its OWN rollout cohort, keyed by harness.
  expect(state.rollout).toHaveBeenCalledWith("bearer", "project", "codex");
  // An uncertified architecture stays hosted (D8).
  state.codexTargets = ["linux-x64"];
  expect(await shouldUseLocalHarness("codex", "bearer", "project")).toBe(false);
});
it("does not run unknown harnesses locally or evaluate their account rollout", async () => {
  expect(await shouldUseLocalHarness("cursor")).toBe(false);
  expect(await shouldUseLocalHarness(undefined)).toBe(false);
  expect(state.rollout).not.toHaveBeenCalled();
});
it("selects local Codex for evals and swarms only where its command sandbox was measured (D2)", async () => {
  state.codexConformance = "tested";
  // Attended (Playground) is unaffected by the unattended sandbox evidence.
  expect(await shouldUseLocalHarness("codex", "bearer", "project")).toBe(true);
  // No measured target: unattended work never selects the local venue.
  expect(await shouldUseLocalHarness("codex", "bearer", "project", { scope: "unattended" })).toBe(false);
  state.codexSandboxTargets = ["linux-x64"];
  expect(await shouldUseLocalHarness("codex", "bearer", "project", { scope: "unattended" })).toBe(false);
  state.codexSandboxTargets = ["darwin-arm64"];
  expect(await shouldUseLocalHarness("codex", "bearer", "project", { scope: "unattended" })).toBe(true);
  // Claude Code declares no such dependency; its unattended venue is unchanged.
  expect(await shouldUseLocalHarness("claude-code", "bearer", "project", { scope: "unattended" })).toBe(true);
});
