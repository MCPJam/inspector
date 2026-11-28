import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  decide: vi.fn(),
  member: vi.fn(),
  boxes: vi.fn(() => false),
  warn: vi.fn(),
  install: vi.fn(),
}));
vi.mock("../run-resources.js", () => ({ decideLocalHarnessVenue: mocks.decide }));
vi.mock("../readiness.js", () => ({ localHarnessMemberRefusal: mocks.member }));
vi.mock("../../harness-box.js", () => ({ canProvisionHarnessBoxes: mocks.boxes }));
vi.mock("../runtime-install.js", () => ({ readRuntimeInstallStatus: mocks.install }));
vi.mock("../../../logger.js", () => ({ logger: { warn: mocks.warn } }));
import { localEvalVenue } from "../eval-venue.js";
import { localVenueStatus } from "../venue-refusal.js";

const ASK = { harnessId: "claude-code", bearer: "token", projectId: "project" } as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.boxes.mockReturnValue(false);
  mocks.install.mockResolvedValue({ state: "ready", packVersion: "1", runtimeRoot: "/r", digest: "d" });
});

describe("where an eval runs, asked before launch", () => {
  it("asks the launch's own unattended rule with the member's sign-in and project", async () => {
    mocks.decide.mockResolvedValue({ venue: "local", harnessId: "claude-code" });
    await expect(localEvalVenue(ASK)).resolves.toEqual({ venue: "local" });
    expect(mocks.decide).toHaveBeenCalledWith("claude-code", "token", "project", { scope: "unattended" });
    expect(mocks.member).not.toHaveBeenCalled();
  });

  it("answers the cloud where this Inspector can start a cloud computer, without asking why", async () => {
    mocks.decide.mockResolvedValue({ venue: "hosted", refusal: "member", harnessId: "claude-code" });
    mocks.boxes.mockReturnValue(true);
    await expect(localEvalVenue(ASK)).resolves.toEqual({ venue: "cloud" });
    expect(mocks.member).not.toHaveBeenCalled();
  });

  it("offers setup to a member the Playground would offer it to", async () => {
    mocks.decide.mockResolvedValue({ venue: "hosted", refusal: "member", harnessId: "claude-code" });
    mocks.member.mockResolvedValue("not-set-up");
    await expect(localEvalVenue(ASK)).resolves.toEqual({
      venue: "refused",
      refusal: "not-set-up",
      message: "Claude Code isn't set up for this project on this machine.",
      fix: "set-up",
    });
    expect(mocks.member).toHaveBeenCalledWith("token", "project", "claude-code");
  });

  it("names a machine rule and sends the member to another client", async () => {
    mocks.decide.mockResolvedValue({ venue: "hosted", refusal: "unattended-unverified", harnessId: "codex" });
    await expect(localEvalVenue({ ...ASK, harnessId: "codex" })).resolves.toEqual({
      venue: "refused",
      refusal: "unattended-unverified",
      message: "Evals with Codex run locally only on Macs with Apple silicon.",
      fix: "choose-another",
    });
  });

  it("asks for a retry only when the account check itself failed, and logs why", async () => {
    mocks.decide.mockRejectedValue(new Error("Local Claude Code authorization could not be verified."));
    mocks.member.mockResolvedValue("rollout-unknown");
    await expect(localEvalVenue(ASK)).resolves.toMatchObject({ venue: "refused", refusal: "rollout-unknown", fix: "retry" });
    expect(mocks.warn).toHaveBeenCalledWith(
      "[local-harness] could not decide an eval's venue",
      expect.objectContaining({ harnessId: "claude-code" }),
    );
  });

  it.each(["flags-off", "not-rolled-out"] as const)(
    "names a set-up member's %s refusal instead of a retry that can't help",
    async (refusal) => {
      // An authorization here and a rollout that says no: the account check throws.
      mocks.decide.mockRejectedValue(new Error("Local Claude Code authorization could not be verified."));
      mocks.member.mockResolvedValue(refusal);
      await expect(localEvalVenue(ASK)).resolves.toMatchObject({ venue: "refused", refusal, fix: "choose-another" });
    },
  );

  it("doesn't answer this machine until the runtime is installed", async () => {
    mocks.decide.mockResolvedValue({ venue: "local", harnessId: "claude-code" });
    mocks.install.mockResolvedValueOnce({ state: "downloading", packVersion: "1", percent: 40 });
    await expect(localEvalVenue(ASK)).resolves.toEqual({
      venue: "refused",
      refusal: "installing",
      message: "Claude Code is still installing on this machine.",
      fix: "set-up",
    });
    mocks.install.mockResolvedValueOnce({ state: "failed", packVersion: "1", reason: "network", message: "download failed" });
    await expect(localEvalVenue(ASK)).resolves.toEqual({
      venue: "refused",
      refusal: "not-installed",
      message: "Claude Code isn't installed on this machine.",
      fix: "set-up",
    });
  });

  it("names no setup a sign-in can't provide", async () => {
    mocks.decide.mockResolvedValue({ venue: "hosted", refusal: "member", harnessId: "claude-code" });
    mocks.member.mockResolvedValue("actor-refused");
    await expect(localEvalVenue(ASK)).resolves.toEqual({
      venue: "refused",
      refusal: "unavailable",
      message: "Claude Code can't run evals on this machine for your account.",
      fix: "choose-another",
    });
  });
});

describe("the run sheet's text for a refusal", () => {
  it("says what is missing before the run, with one fix each", () => {
    expect(localVenueStatus("not-rolled-out", "claude-code")).toEqual({
      message: "Claude Code isn't available for your account yet.",
      fix: "choose-another",
    });
    expect(localVenueStatus("rollout-unknown", "claude-code")).toEqual({
      message: "Couldn't check whether Claude Code can run on this machine. Check your connection, then retry.",
      fix: "retry",
    });
    expect(localVenueStatus("flags-off", "claude-code")).toEqual({
      message: "DO_NOT_TRACK is set, so this Inspector can't check whether Claude Code can run on this machine.",
      fix: "choose-another",
    });
    expect(localVenueStatus("unsupported-platform", "codex")).toEqual({
      message: "Codex doesn't support this machine's operating system or processor.",
      fix: "choose-another",
    });
    expect(localVenueStatus("not-released", "claude-code")).toEqual({
      message: "Claude Code isn't available to run locally yet.",
      fix: "choose-another",
    });
    expect(localVenueStatus("turned-off", "claude-code")).toEqual({
      message: "Running clients locally is turned off in this Inspector.",
      fix: "choose-another",
    });
  });
});
