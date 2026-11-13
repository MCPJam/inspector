import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  grantLocalHarnessConsent,
  revokeLocalHarnessGrants,
  type HarnessGrantBinding,
} from "../grants.js";
import {
  rememberLaunchCredentials,
  resetLaunchCredentialsForTests,
  reusableLaunchCredentials,
} from "../launch-credentials.js";
import { LOCAL_HARNESS_POLICY_VERSION } from "../targets.js";

let home: string;
const realHome = process.env.HOME;

const binding: HarnessGrantBinding = {
  scope: "attended",
  userId: "user_1",
  machineId: "mach_1",
  projectId: "proj_1",
  workspaceGrantId: "ws_1",
  harnessId: "codex",
  targetKind: "local-native",
  runtimeId: "rt_1",
  permissionProfile: "workspace-edits",
  policyVersion: LOCAL_HARNESS_POLICY_VERSION,
};

beforeAll(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "mcpjam-launch-")));
  process.env.HOME = home;
});

afterAll(async () => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  resetLaunchCredentialsForTests();
  await revokeLocalHarnessGrants();
});

describe("a chat turn's kept registration and grant", () => {
  it("are handed back only for the same terms and instance key", async () => {
    const grant = await grantLocalHarnessConsent(binding, { ttlMs: 15 * 60_000 });
    rememberLaunchCredentials(binding, "public-key", { keyId: "hik_1", grant });
    await expect(reusableLaunchCredentials(binding, "public-key")).resolves.toEqual({ keyId: "hik_1", grant });
    await expect(reusableLaunchCredentials({ ...binding, workspaceGrantId: "ws_2" }, "public-key")).resolves.toBeNull();
    await expect(reusableLaunchCredentials({ ...binding, runtimeId: "rt_2" }, "public-key")).resolves.toBeNull();
    await expect(reusableLaunchCredentials(binding, "another-key")).resolves.toBeNull();
  });

  it("are never handed to a turn once the grant is revoked", async () => {
    const grant = await grantLocalHarnessConsent(binding, { ttlMs: 15 * 60_000 });
    rememberLaunchCredentials(binding, "public-key", { keyId: "hik_1", grant });
    await revokeLocalHarnessGrants({ grantId: grant.grantId });
    await expect(reusableLaunchCredentials(binding, "public-key")).resolves.toBeNull();
    // Dropped, not kept for a later look.
    const renewed = await grantLocalHarnessConsent(binding, { ttlMs: 15 * 60_000 });
    await expect(reusableLaunchCredentials(binding, "public-key")).resolves.toBeNull();
    expect(renewed.token).not.toBe(grant.token);
  });

  it("stop being reused before the grant expires, rather than extend it", async () => {
    const grant = await grantLocalHarnessConsent(binding, { ttlMs: 4 * 60_000 });
    rememberLaunchCredentials(binding, "public-key", { keyId: "hik_1", grant });
    await expect(reusableLaunchCredentials(binding, "public-key")).resolves.toBeNull();
  });
});
