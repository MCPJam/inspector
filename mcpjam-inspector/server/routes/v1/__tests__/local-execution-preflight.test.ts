import { beforeEach, describe, expect, it, vi } from "vitest";
const { member, runtime, availability } = vi.hoisted(() => ({
  member: vi.fn(),
  runtime: vi.fn(),
  availability: vi.fn(),
}));
vi.mock("../../../utils/harness/local/readiness.js", () => ({
  verifyLocalHarnessMember: member,
}));
vi.mock("../../../utils/harness/local/runtime-install.js", () => ({
  readRuntimeInstallStatus: runtime,
}));
vi.mock("../../../utils/harness/local/availability.js", () => ({
  resolveLocalHarnessAvailability: availability,
}));
vi.mock("../../../utils/harness/local/local-turn.js", () => ({
  readInstalledAdapterVersion: async () => "adapter",
}));
import {
  assertPlatformExecutionVenue,
  preflightLocalExecution,
} from "../local-execution-preflight";
const target = {
  kind: "local-native",
  scope: "unattended",
  harnessId: "codex",
  machineId: "machine",
  workspaceGrantId: "workspace",
  runtimeId: "runtime",
  permissionProfile: "unrestricted",
  policyVersion: "policy",
} as const;
const args = {
  target,
  grantToken: "capability",
  bearer: "Bearer verified",
  projectId: "project",
  hostConfig: { harness: "codex" },
};
beforeEach(() => {
  vi.clearAllMocks();
  member.mockResolvedValue({ userId: "authkit:verified" });
  runtime.mockResolvedValue({
    state: "ready",
    runtimeRoot: "/verified",
    digest: "digest",
  });
  availability.mockResolvedValue({ available: true, plan: {} });
});
describe("local execution preflight", () => {
  it("rechecks the grant against the server actor and selected runtime", async () => {
    expect(await preflightLocalExecution(args)).toMatchObject({
      actingUserId: "authkit:verified",
      scope: "unattended",
    });
    expect(availability).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "authkit:verified",
        scope: "unattended",
        runtimeDigest: "digest",
        grantToken: "capability",
        target,
      }),
    );
  });
  it.each([
    { grantToken: undefined },
    { hostConfig: { harness: "claude-code" } },
    { hostConfig: { harness: "codex", requireToolApproval: true } },
  ])(
    "rejects absent authority or an incompatible client before runtime allocation",
    async (override) => {
      await expect(
        preflightLocalExecution({ ...args, ...override }),
      ).rejects.toThrow();
      expect(availability).not.toHaveBeenCalled();
    },
  );
  it("refuses an unavailable runtime before checking launch availability", async () => {
    runtime.mockResolvedValue({ state: "absent" });
    await expect(preflightLocalExecution(args)).rejects.toThrow(/unavailable/);
    expect(availability).not.toHaveBeenCalled();
  });
  it.each(["expired", "machine-mismatch", "runtime-changed"])(
    "refuses %s authority",
    async (status) => {
      availability.mockResolvedValue({
        available: false,
        status,
        message: status,
      });
      await expect(preflightLocalExecution(args)).rejects.toThrow(status);
    },
  );
  it("does not carry on after actor verification fails", async () => {
    member.mockRejectedValue(new Error("invalid actor"));
    await expect(preflightLocalExecution(args)).rejects.toThrow(
      "invalid actor",
    );
    expect(runtime).not.toHaveBeenCalled();
  });
});
describe("session venue binding", () => {
  it.each(["hosted", "local-native"] as const)(
    "pins %s without rewriting it",
    (venue) => {
      expect(assertPlatformExecutionVenue(undefined, venue)).toBe(venue);
      expect(assertPlatformExecutionVenue(venue, venue)).toBe(venue);
    },
  );
  it.each([undefined, "hosted"] as const)(
    "refuses an omitted or hosted target on a local continuation",
    (requested) => {
      expect(() =>
        assertPlatformExecutionVenue("local-native", requested),
      ).toThrow(/original execution venue/);
    },
  );
});
