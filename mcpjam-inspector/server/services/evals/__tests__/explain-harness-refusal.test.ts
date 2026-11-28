import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ hosted: false, decide: vi.fn(), describe: vi.fn() }));
vi.mock("../../../config.js", async (original) => ({
  ...await original<typeof import("../../../config.js")>(),
  get HOSTED_MODE() { return state.hosted; },
}));
vi.mock("../../../utils/harness/local/run-resources.js", async (original) => ({
  ...await original<typeof import("../../../utils/harness/local/run-resources.js")>(),
  decideLocalHarnessVenue: state.decide,
}));
vi.mock("../../../utils/harness/local/venue-refusal.js", () => ({ describeLocalVenueRefusal: state.describe }));
import { explainEvalHarnessRefusal } from "../explain-harness-refusal.js";
import { harnessNeedsProjectReason } from "../harness-admission.js";

const cloudRefusal = {
  ok: false as const,
  harness: "claude-code" as const,
  reason: "The Claude Code client needs a cloud computer, which is unavailable right now.",
  kind: "computers-unconfigured" as const,
};

beforeEach(() => {
  state.hosted = false;
  state.decide.mockReset().mockResolvedValue({ venue: "hosted", refusal: "member", harnessId: "claude-code" });
  state.describe.mockReset().mockResolvedValue("Set it up in the Playground.");
});

it("explains a missing cloud computer on a local Inspector with why this machine couldn't run it", async () => {
  await expect(explainEvalHarnessRefusal({ admission: cloudRefusal, bearer: "token", projectId: "project" }))
    .resolves.toBe("Set it up in the Playground.");
  // The same rules the launch asked, for evals: the unattended scope.
  expect(state.decide).toHaveBeenCalledWith("claude-code", "token", "project", { scope: "unattended" });
  expect(state.describe).toHaveBeenCalledWith(
    { venue: "hosted", refusal: "member", harnessId: "claude-code" },
    { bearer: "token", projectId: "project" },
  );
});

it("keeps every other refusal's text, and every refusal on the hosted app", async () => {
  const brokerOff = { ...cloudRefusal, kind: "broker-disabled" as const, reason: "credentials" };
  await expect(explainEvalHarnessRefusal({ admission: brokerOff, bearer: "token", projectId: "project" })).resolves.toBe("credentials");
  const noKind = { ok: false as const, harness: "claude-code" as const, reason: "model" };
  await expect(explainEvalHarnessRefusal({ admission: noKind, bearer: "token", projectId: "project" })).resolves.toBe("model");
  state.hosted = true;
  await expect(explainEvalHarnessRefusal({ admission: cloudRefusal, bearer: "token", projectId: "project" })).resolves.toBe(cloudRefusal.reason);
  expect(state.decide).not.toHaveBeenCalled();
});

it("gives an organization-level suite the existing project refusal", async () => {
  await expect(explainEvalHarnessRefusal({ admission: cloudRefusal, bearer: "token", projectId: null }))
    .resolves.toBe(harnessNeedsProjectReason("claude-code"));
  expect(state.decide).not.toHaveBeenCalled();
});

it("keeps the original text when there is nothing more specific, or the explanation itself fails", async () => {
  state.describe.mockResolvedValue(null);
  await expect(explainEvalHarnessRefusal({ admission: cloudRefusal, bearer: "token", projectId: "project" })).resolves.toBe(cloudRefusal.reason);
  state.decide.mockRejectedValue(new Error("Local Claude Code authorization could not be verified."));
  await expect(explainEvalHarnessRefusal({ admission: cloudRefusal, bearer: "token", projectId: "project" })).resolves.toBe(cloudRefusal.reason);
});
