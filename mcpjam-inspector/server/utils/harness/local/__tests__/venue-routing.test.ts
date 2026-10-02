import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ enabled: true, hosted: false, pack: true, conformance: "tested", rollout: vi.fn() }));
vi.mock("../../../../config.js", () => ({ get HOSTED_MODE() { return state.hosted; }, get LOCAL_HARNESS_ENABLED() { return state.enabled; } }));
vi.mock("../runtime-install.js", () => ({ expectedPackFor: () => state.pack ? {} : null }));
vi.mock("../targets.js", () => ({ localPackTarget: () => "darwin-arm64" }));
vi.mock("../availability.js", () => ({ localHarnessManifestsForDevelopment: () => ({ "claude-code": { lifecycleConformanceVersion: state.conformance } }) }));
vi.mock("../readiness.js", () => ({ ensureLocalHarnessTarget: vi.fn(), localHarnessAccountEnabled: state.rollout }));
import { shouldUseLocalHarness } from "../run-resources.js";
beforeEach(() => { state.enabled = true; state.hosted = false; state.pack = true; state.conformance = "tested"; state.rollout.mockReset().mockResolvedValue(true); });
it("requires every local eligibility gate and preserves cloud selection otherwise", async () => {
  expect(await shouldUseLocalHarness("claude-code", "bearer", "project")).toBe(true);
  expect(state.rollout).toHaveBeenCalledWith("bearer", "project");
  state.enabled = false; expect(await shouldUseLocalHarness("claude-code")).toBe(false); state.enabled = true;
  state.pack = false; expect(await shouldUseLocalHarness("claude-code")).toBe(false); state.pack = true;
  state.conformance = ""; expect(await shouldUseLocalHarness("claude-code")).toBe(false); state.conformance = "tested";
  state.hosted = true; expect(await shouldUseLocalHarness("claude-code")).toBe(false); state.hosted = false;
  state.rollout.mockResolvedValue(false); expect(await shouldUseLocalHarness("claude-code")).toBe(false);
});
it("does not run other harnesses locally or evaluate their account rollout", async () => {
  expect(await shouldUseLocalHarness("codex")).toBe(false);
  expect(await shouldUseLocalHarness(undefined)).toBe(false);
  expect(state.rollout).not.toHaveBeenCalled();
});
