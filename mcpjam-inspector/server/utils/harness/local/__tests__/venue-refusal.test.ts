import { beforeEach, describe, expect, it, vi } from "vitest";
const member = vi.hoisted(() => ({ refusal: vi.fn() }));
vi.mock("../readiness.js", () => ({ localHarnessMemberRefusal: member.refusal }));
import { LOCAL_HARNESS_MANIFEST } from "../compatibility.js";
import { localHarnessManifestsForDevelopment } from "../availability.js";
import { describeLocalVenueRefusal, LOCAL_TARGET_LABELS, localVenueRefusalText } from "../venue-refusal.js";

beforeEach(() => {
  member.refusal.mockReset();
});

describe("the text a refusal shows", () => {
  it("names what happened, the cause and one next step, in the Playground's words", () => {
    expect(localVenueRefusalText("not-set-up", "claude-code")).toBe(
      "Couldn't run Claude Code on this machine because it isn't set up for this project. Set it up in the Playground, then run the eval again.",
    );
    expect(localVenueRefusalText("not-rolled-out", "claude-code")).toBe(
      "Couldn't run Claude Code on this machine because it isn't available for your account yet. Choose another client.",
    );
    expect(localVenueRefusalText("rollout-unknown", "claude-code")).toBe(
      "Couldn't check whether Claude Code can run on this machine. Check your connection, then run the eval again.",
    );
    expect(localVenueRefusalText("flags-off", "claude-code")).toBe(
      "Couldn't run Claude Code on this machine because DO_NOT_TRACK is set, so this Inspector can't check access to local clients. Choose another client.",
    );
    expect(localVenueRefusalText("unsupported-platform", "codex")).toBe(
      "Couldn't run Codex on this machine because it doesn't support this operating system or processor. Choose another client.",
    );
    expect(localVenueRefusalText("not-released", "claude-code")).toBe(
      "Couldn't run Claude Code on this machine because it isn't available to run locally yet. Choose another client.",
    );
    expect(localVenueRefusalText("turned-off", "claude-code")).toBe(
      "Couldn't run Claude Code on this machine because running clients locally is turned off in this Inspector. Choose another client.",
    );
  });

  it("names where Codex's unattended sandbox was verified, read from its manifest", () => {
    expect(localVenueRefusalText("unattended-unverified", "codex")).toBe(
      "Couldn't run this eval on this machine because evals with Codex run locally only on Macs with Apple silicon. Choose another client.",
    );
  });

  it("can name every target a manifest verifies unattended runs on", () => {
    const manifests = Object.values(localHarnessManifestsForDevelopment(LOCAL_HARNESS_MANIFEST));
    for (const target of manifests.flatMap((manifest) => manifest?.unattendedSandboxTargets ?? [])) {
      expect(LOCAL_TARGET_LABELS[target], target).toBeTruthy();
    }
  });
});

describe("describing a decision that kept a harness off this machine", () => {
  it("has nothing to add for a harness that ran here, has no local runtime, or a hosted server", async () => {
    await expect(describeLocalVenueRefusal({ venue: "local", harnessId: "claude-code" }, {})).resolves.toBeNull();
    await expect(describeLocalVenueRefusal({ venue: "hosted", refusal: "unsupported-harness", harnessId: null }, {})).resolves.toBeNull();
    await expect(describeLocalVenueRefusal({ venue: "hosted", refusal: "hosted-server", harnessId: "claude-code" }, {})).resolves.toBeNull();
    expect(member.refusal).not.toHaveBeenCalled();
  });

  it("names a machine rule without asking about the account", async () => {
    await expect(describeLocalVenueRefusal({ venue: "hosted", refusal: "turned-off", harnessId: "claude-code" }, { bearer: "token", projectId: "project" }))
      .resolves.toBe(localVenueRefusalText("turned-off", "claude-code"));
    expect(member.refusal).not.toHaveBeenCalled();
  });

  it("narrows an account refusal only now, after the refusal", async () => {
    member.refusal.mockResolvedValue("not-set-up");
    await expect(describeLocalVenueRefusal({ venue: "hosted", refusal: "member", harnessId: "codex" }, { bearer: "token", projectId: "project" }))
      .resolves.toBe(localVenueRefusalText("not-set-up", "codex"));
    expect(member.refusal).toHaveBeenCalledWith("token", "project", "codex");
  });

  it("names no fix a sign-in can't provide", async () => {
    member.refusal.mockResolvedValue("actor-refused");
    await expect(describeLocalVenueRefusal({ venue: "hosted", refusal: "member", harnessId: "claude-code" }, { bearer: "token" })).resolves.toBeNull();
    member.refusal.mockResolvedValue(null);
    await expect(describeLocalVenueRefusal({ venue: "hosted", refusal: "member", harnessId: "claude-code" }, { bearer: "token" })).resolves.toBeNull();
  });
});
