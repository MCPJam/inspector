import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  query: vi.fn(), actor: vi.fn(), authorization: vi.fn(), grant: vi.fn(), rollout: vi.fn(),
  status: vi.fn(), install: vi.fn(), register: vi.fn(),
}));
vi.mock("convex/browser", () => ({ ConvexHttpClient: class { setAuth() {} query = mocks.query; } }));
vi.mock("../../../../config.js", () => ({ HOSTED_MODE: false, LOCAL_HARNESS_ENABLED: true }));
vi.mock("../acting-user.js", () => ({ resolveLocalHarnessActor: mocks.actor }));
vi.mock("../authorization.js", () => ({ readLocalHarnessAuthorization: mocks.authorization, authorizeLocalHarness: vi.fn() }));
vi.mock("../../../analytics.js", () => ({ evaluateLocalHarnessRollout: mocks.rollout, LOCAL_HARNESS_ROLLOUT_FLAG: { "claude-code": "local-harness-enabled", codex: "local-codex-enabled" } }));
vi.mock("../runtime-install.js", () => ({ readRuntimeInstallStatus: mocks.status, installRuntimePack: mocks.install, startRuntimeInstall: vi.fn(), manifestWithExpectedBundleDigest: (value: unknown) => value }));
vi.mock("../runtime-identity.js", () => ({ resolveManagedBundle: async () => ({ ok: true, runtime: { runtimeId: "verified-runtime", adapterVersion: "1", digest: "sha256:verified" } }) }));
vi.mock("../availability.js", () => ({ localHarnessManifestsForDevelopment: (value: unknown) => value }));
vi.mock("../grants.js", () => ({
  getLocalMachineId: async () => "machine", grantLocalHarnessConsent: mocks.grant,
  localHarnessStateRoot: () => "/unused", registerWorkspaceGrant: vi.fn(),
  resolveWorkspaceGrant: async () => ({ ok: true, canonicalPath: "/workspace" }),
}));
vi.mock("../instance-key.js", () => ({ readLocalInstanceIdentity: async () => ({ publicKey: "key", keyId: "registered" }), setRegisteredKeyId: vi.fn() }));
vi.mock("../../harness-model-broker.js", () => ({ registerLocalInstance: mocks.register }));
import { ensureLocalHarnessTarget, localHarnessAccountEnabled } from "../readiness.js";
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

