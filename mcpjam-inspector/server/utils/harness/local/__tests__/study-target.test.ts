import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  reservation: vi.fn(),
  workspace: vi.fn(),
  member: vi.fn(),
}));
vi.mock("../readiness.js", () => ({ verifyLocalHarnessMember: mocks.member }));
vi.mock("../instance-key.js", () => ({
  readLocalInstanceIdentity: async () => ({ keyId: "key" }),
  getRegisteredKeyId: () => null,
}));
vi.mock("../study-access.js", () => ({
  requestLocalStudyReservation: mocks.reservation,
}));
vi.mock("../study-workspace.js", () => ({
  prepareLocalStudyWorkspace: mocks.workspace,
}));
vi.mock("../grants.js", async (original) => ({
  ...(await original<typeof import("../grants.js")>()),
  getLocalMachineId: async () => "machine",
}));
import {
  grantLocalHarnessConsent,
  revokeLocalHarnessGrants,
} from "../grants.js";
import { LOCAL_HARNESS_POLICY_VERSION } from "../targets.js";
import { resolveLocalStudyTarget } from "../study-target.js";

const study = { scenarioId: "study", accessVersion: 1, chatSessionId: "chat" };
const target = {
  kind: "local-native" as const,
  workspaceGrantId: "workspace",
  machineId: "machine",
  runtimeId: "runtime",
  permissionProfile: "workspace-edits" as const,
  policyVersion: LOCAL_HARNESS_POLICY_VERSION,
  localStudySessionId: "reservation",
};
const binding = {
  ...target,
  study,
  scope: "attended" as const,
  userId: "actual-user",
  projectId: "project",
  harnessId: "codex" as const,
  targetKind: "local-native" as const,
};
let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "study-target-"));
  vi.stubEnv("HOME", home);
  vi.clearAllMocks();
  mocks.member.mockResolvedValue({ userId: "actual-user" });
  mocks.reservation.mockResolvedValue({
    ...study,
    projectId: "project",
    reservationId: "reservation",
  });
  mocks.workspace.mockResolvedValue({
    workspaceGrantId: "workspace",
    localSessionId: "private-session",
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});
const request = (grantToken: string) => ({
  bearer: "bearer",
  projectId: "project",
  harnessId: "codex" as const,
  study,
  rawTarget: target,
  grantToken,
});

it("requires both the actual backend reservation and separately minted study grant", async () => {
  const grant = await grantLocalHarnessConsent(binding);
  const result = await resolveLocalStudyTarget(request(grant.token));
  expect(result).toMatchObject({
    actingUserId: "actual-user",
    study,
    localStudySessionId: "reservation",
    localSessionId: "private-session",
  });
  expect(mocks.reservation).toHaveBeenCalledWith("bearer", {
    action: "validate",
    reservationId: "reservation",
    machineId: "machine",
    keyId: "key",
  });
});

it("refuses an ordinary project grant even for the same actor and workspace", async () => {
  const { study: _study, ...ordinary } = binding;
  const grant = await grantLocalHarnessConsent(ordinary);
  await expect(resolveLocalStudyTarget(request(grant.token))).rejects.toThrow(
    "different terms",
  );
  expect(mocks.workspace).not.toHaveBeenCalled();
});

it.each([
  { scenarioId: "other" },
  { accessVersion: 2 },
  { chatSessionId: "other" },
  { projectId: "other" },
])("refuses backend scope substitution %j", async (change) => {
  mocks.reservation.mockResolvedValue({
    ...study,
    projectId: "project",
    ...change,
  });
  const grant = await grantLocalHarnessConsent(binding);
  await expect(resolveLocalStudyTarget(request(grant.token))).rejects.toThrow(
    "another study conversation",
  );
  expect(mocks.workspace).not.toHaveBeenCalled();
});

it("refuses another machine, missing reservation, expiry and revocation", async () => {
  const grant = await grantLocalHarnessConsent(binding);
  await expect(
    resolveLocalStudyTarget({
      ...request(grant.token),
      rawTarget: { ...target, machineId: "other" },
    }),
  ).rejects.toThrow("another installation");
  await expect(
    resolveLocalStudyTarget({
      ...request(grant.token),
      rawTarget: { ...target, localStudySessionId: undefined },
    }),
  ).rejects.toThrow("Authorize this study");
  const expired = await grantLocalHarnessConsent(binding, { now: 0, ttlMs: 1 });
  await expect(resolveLocalStudyTarget(request(expired.token))).rejects.toThrow(
    "expired",
  );
  await revokeLocalHarnessGrants({ grantId: grant.grantId });
  await expect(resolveLocalStudyTarget(request(grant.token))).rejects.toThrow(
    "no local harness grant",
  );
});

it("refuses a workspace that no longer belongs to this Inspector session", async () => {
  const grant = await grantLocalHarnessConsent(binding);
  mocks.workspace.mockResolvedValue({ workspaceGrantId: "another-workspace" });
  await expect(resolveLocalStudyTarget(request(grant.token))).rejects.toThrow(
    "after restarting",
  );
});
