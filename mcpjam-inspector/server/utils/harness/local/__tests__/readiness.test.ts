import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  query: vi.fn(), actor: vi.fn(), authorization: vi.fn(), grant: vi.fn(), rollout: vi.fn(),
  status: vi.fn(), install: vi.fn(), register: vi.fn(),
  workspace: vi.fn(async () => ({ ok: true, grant: { workspaceGrantId: "set-up-workspace" } })),
  background: vi.fn(async () => ({ kind: "started" })), policy: vi.fn(() => "auto"),
}));
vi.mock("convex/browser", () => ({ ConvexHttpClient: class { setAuth() {} query = mocks.query; } }));
vi.mock("../../../../config.js", () => ({ HOSTED_MODE: false, LOCAL_HARNESS_ENABLED: true }));
vi.mock("../acting-user.js", () => ({ resolveLocalHarnessActor: mocks.actor }));
vi.mock("../authorization.js", () => ({ readLocalHarnessAuthorization: mocks.authorization, authorizeLocalHarness: vi.fn() }));
vi.mock("../../../analytics.js", () => ({ evaluateLocalHarnessRollout: mocks.rollout, LOCAL_HARNESS_ROLLOUT_FLAG: { "claude-code": "local-harness-enabled", codex: "local-codex-enabled" } }));
vi.mock("../runtime-install.js", () => ({ readRuntimeInstallStatus: mocks.status, installRuntimePack: mocks.install, startRuntimeInstall: vi.fn(), startBackgroundRuntimeUpdate: mocks.background, MANUAL_UPDATES_MESSAGE: "managed by your administrator", manifestWithExpectedBundleDigest: (value: unknown) => value }));
vi.mock("../runtime-update-policy.js", () => ({ readLocalRuntimeUpdatePolicy: async () => ({ policy: mocks.policy(), source: null }) }));
vi.mock("../runtime-identity.js", () => ({ resolveManagedBundle: async () => ({ ok: true, runtime: { runtimeId: "verified-runtime", adapterVersion: "1", digest: "sha256:verified" } }) }));
vi.mock("../availability.js", () => ({ localHarnessManifestsForDevelopment: (value: unknown) => value }));
vi.mock("../grants.js", () => ({
  getLocalMachineId: async () => "machine", grantLocalHarnessConsent: mocks.grant,
  localHarnessStateRoot: () => "/unused", registerWorkspaceGrant: mocks.workspace,
  resolveWorkspaceGrant: async () => ({ ok: true, canonicalPath: "/workspace" }),
}));
vi.mock("../instance-key.js", () => ({ readLocalInstanceIdentity: async () => ({ publicKey: "key", keyId: "registered" }), setRegisteredKeyId: vi.fn() }));
vi.mock("../../harness-model-broker.js", () => ({ registerLocalInstance: mocks.register }));
import { ensureLocalHarnessTarget, localHarnessAccountEnabled, setupLocalHarness } from "../readiness.js";
const actor = { credential: "authkit" as const, subject: "user", userId: "authkit:user" };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CONVEX_URL", "https://example.convex.cloud");
  mocks.actor.mockResolvedValue({ ok: true, actor });
  mocks.query.mockImplementation(async (name: string) => name === "projects:getMyProjects" ? [{ _id: "project" }] : { externalId: "user" });
  mocks.rollout.mockResolvedValue(true);
  mocks.authorization.mockResolvedValue({ workspaceGrantId: "saved-workspace" });
  mocks.status.mockResolvedValue({ state: "ready", runtimeRoot: "/runtime", packVersion: "1" });
  mocks.register.mockResolvedValue({ ok: true, keyId: "registered" });
  mocks.grant.mockResolvedValue({ grantId: "fresh-grant", token: "fresh-token", expiresAt: "2099-01-01" });
});
describe("shared local readiness", () => {
  it("renews credentials from durable authorization without another setup action", async () => {
    const ready = await ensureLocalHarnessTarget({ bearer: "session", projectId: "project", scope: "attended" });
    expect(ready.target).toMatchObject({ workspaceGrantId: "saved-workspace", runtimeId: "verified-runtime", grantToken: "fresh-token", permissionProfile: "workspace-edits" });
    expect(mocks.authorization).toHaveBeenCalledWith("authkit:user", "machine", "project", "claude-code");
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it("rechecks membership and refuses revoked authorization before minting a grant", async () => {
    mocks.query.mockResolvedValue([]);
    await expect(ensureLocalHarnessTarget({ bearer: "session", projectId: "project", scope: "attended" })).rejects.toThrow(/membership/);
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it("binds background execution to the captured member and session-owned workspace", async () => {
    const ready = await ensureLocalHarnessTarget({ bearer: "delegated", projectId: "project", scope: "unattended", workspaceGrantId: "scratch", trustedActor: actor });
    expect(mocks.actor).not.toHaveBeenCalled();
    expect(ready.target).toMatchObject({ workspaceGrantId: "scratch", permissionProfile: "unrestricted" });
    expect(mocks.grant).toHaveBeenCalledWith(expect.objectContaining({ scope: "unattended", userId: "authkit:user" }), expect.any(Object));
    mocks.query.mockImplementation(async (name: string) => name === "projects:getMyProjects" ? [{ _id: "project" }] : { externalId: "different-user" });
    await expect(ensureLocalHarnessTarget({ bearer: "delegated", projectId: "project", scope: "unattended", trustedActor: actor })).rejects.toThrow(/identity changed/);
  });
});

it("refuses a removed durable authorization before starting any runtime", async () => {
  mocks.authorization.mockResolvedValue(null);
  await expect(ensureLocalHarnessTarget({ bearer: "session", projectId: "project", scope: "attended" })).rejects.toThrow(/Add client/);
  expect(mocks.install).not.toHaveBeenCalled();
  expect(mocks.grant).not.toHaveBeenCalled();
});
it("refuses rollout removal before issuing a grant", async () => {
  mocks.rollout.mockResolvedValue(false);
  await expect(ensureLocalHarnessTarget({ bearer: "session", projectId: "project", scope: "attended" })).rejects.toThrow(/not available/);
  expect(mocks.grant).not.toHaveBeenCalled();
});

it("preserves local intent on rollout or verification failure after authorization", async () => {
  mocks.rollout.mockResolvedValue(false);
  await expect(localHarnessAccountEnabled("session", "project")).rejects.toThrow(/could not be verified/);
  mocks.query.mockRejectedValue(new Error("backend offline"));
  await expect(localHarnessAccountEnabled("session", "project")).rejects.toThrow("backend offline");
  mocks.authorization.mockResolvedValue(null);
  await expect(localHarnessAccountEnabled("session", "new-project")).resolves.toBe(false);
});

describe("each local harness has its own authorization, rollout and runtime (D3, D5)", () => {
  it("reads Codex's authorization and Codex's rollout flag, never Claude Code's", async () => {
    const ready = await ensureLocalHarnessTarget({ bearer: "session", projectId: "project", scope: "attended", harnessId: "codex" });
    expect(mocks.authorization).toHaveBeenCalledWith("authkit:user", "machine", "project", "codex");
    expect(mocks.rollout).toHaveBeenCalledWith("user", undefined, "local-codex-enabled");
    expect(mocks.status).toHaveBeenCalledWith({ harnessId: "codex" });
    expect(mocks.grant).toHaveBeenCalledWith(expect.objectContaining({ harnessId: "codex" }), expect.any(Object));
    expect(ready.target).toMatchObject({ permissionProfile: "workspace-edits" });
  });

  it("names the harness the user set up when Codex is not authorized", async () => {
    mocks.authorization.mockResolvedValue(null);
    await expect(ensureLocalHarnessTarget({ bearer: "session", projectId: "project", scope: "attended", harnessId: "codex" })).rejects.toThrow(/Set up Codex from Add client/);
  });

  it("checks the Codex rollout cohort for account eligibility", async () => {
    await localHarnessAccountEnabled("session", "project", "codex");
    expect(mocks.rollout).toHaveBeenCalledWith("user", undefined, "local-codex-enabled");
  });
});

it("refuses attended Off before installation, registration or grant creation", async () => {
  await expect(ensureLocalHarnessTarget({ bearer: "session", projectId: "project", scope: "attended", requireToolApproval: false })).rejects.toMatchObject({ status: "auto-approve-consent-required" });
  expect(mocks.status).not.toHaveBeenCalled();
  expect(mocks.install).not.toHaveBeenCalled();
  expect(mocks.register).not.toHaveBeenCalled();
  expect(mocks.grant).not.toHaveBeenCalled();
});
it("keeps unattended Off independent of attended acknowledgement", async () => {
  const result = await ensureLocalHarnessTarget({ bearer: "session", projectId: "project", scope: "unattended", requireToolApproval: false });
  expect(result.target.permissionProfile).toBe("unrestricted");
});

describe("a turn never waits on a download it does not need", () => {
  it("runs on the permitted previous pack while the desired one installs in the background", async () => {
    mocks.status.mockResolvedValue({ state: "ready", runtimeRoot: "/runtime/1.0.0", packVersion: "1.0.0", digest: "sha256:old", role: "permitted", update: { state: "absent", packVersion: "1.0.1" } });
    const ready = await ensureLocalHarnessTarget({ bearer: "session", projectId: "project", scope: "attended" });
    expect(ready.runtime.packVersion).toBe("1.0.0");
    expect(mocks.background).toHaveBeenCalledWith("claude-code");
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("starts nothing when the desired pack is the one selected", async () => {
    mocks.status.mockResolvedValue({ state: "ready", runtimeRoot: "/runtime", packVersion: "1", role: "desired" });
    await ensureLocalHarnessTarget({ bearer: "session", projectId: "project", scope: "attended" });
    expect(mocks.background).not.toHaveBeenCalled();
  });

  it("waits only on a first-time install", async () => {
    mocks.status.mockResolvedValue({ state: "absent", packVersion: "1" });
    mocks.install.mockResolvedValue({ state: "ready", runtimeRoot: "/runtime", packVersion: "1", digest: "sha256:new" });
    const ready = await ensureLocalHarnessTarget({ bearer: "session", projectId: "project", scope: "attended" });
    expect(mocks.install).toHaveBeenCalledWith({ harnessId: "claude-code", trigger: "readiness" });
    expect(ready.runtime.packVersion).toBe("1");
  });

  it("installs for an explicit setup as the user's gesture, which never backs off", async () => {
    mocks.status.mockResolvedValue({ state: "absent", packVersion: "1" });
    mocks.install.mockResolvedValue({ state: "ready", runtimeRoot: "/runtime", packVersion: "1", digest: "sha256:new" });
    await setupLocalHarness({ bearer: "session", projectId: "project", workspacePath: "/workspace" });
    expect(mocks.install).toHaveBeenCalledWith({ harnessId: "claude-code", trigger: "gesture" });
  });

  it("installs nothing under an administrator's manual update policy", async () => {
    mocks.status.mockResolvedValue({ state: "absent", packVersion: "1" });
    mocks.policy.mockReturnValue("manual");
    await expect(ensureLocalHarnessTarget({ bearer: "session", projectId: "project", scope: "attended" })).rejects.toThrow(/administrator/);
    expect(mocks.install).not.toHaveBeenCalled();
    mocks.policy.mockReturnValue("auto");
  });

  it("fails closed with MCPJam's message when the only installable pack was withdrawn", async () => {
    mocks.status.mockResolvedValue({ state: "revoked", packVersion: "1", message: "MCPJam withdrew the claude-code runtime 1" });
    await expect(ensureLocalHarnessTarget({ bearer: "session", projectId: "project", scope: "attended" })).rejects.toThrow(/withdrew/);
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.grant).not.toHaveBeenCalled();
  });
});

describe("an update never widens permissions (invariant 3)", () => {
  it("re-mints the grant for the new runtime at the SAME profile and policy, under the existing authorization", async () => {
    const { authorizeLocalHarness } = await import("../authorization.js");
    mocks.status.mockResolvedValue({ state: "ready", runtimeRoot: "/runtime/1.0.0", packVersion: "1.0.0", digest: "sha256:old", role: "desired" });
    await ensureLocalHarnessTarget({ bearer: "session", projectId: "project", scope: "attended" });
    const before = mocks.grant.mock.calls.at(-1)![0];
    mocks.status.mockResolvedValue({ state: "ready", runtimeRoot: "/runtime/1.0.1", packVersion: "1.0.1", digest: "sha256:new", role: "desired" });
    await ensureLocalHarnessTarget({ bearer: "session", projectId: "project", scope: "attended" });
    const after = mocks.grant.mock.calls.at(-1)![0];
    expect(after.permissionProfile).toBe(before.permissionProfile);
    expect(after.policyVersion).toBe(before.policyVersion);
    expect(after.scope).toBe(before.scope);
    expect(after.workspaceGrantId).toBe(before.workspaceGrantId);
    // No new consent was recorded: the durable authorization carries over.
    expect(authorizeLocalHarness).not.toHaveBeenCalled();
  });
});
