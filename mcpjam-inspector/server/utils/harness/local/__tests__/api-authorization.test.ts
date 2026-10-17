import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  authorize: vi.fn(), query: vi.fn(), actor: vi.fn(), authorization: vi.fn(), grant: vi.fn(), rollout: vi.fn(),
  status: vi.fn(), install: vi.fn(), register: vi.fn(),
  workspace: vi.fn(async () => ({ ok: true, grant: { workspaceGrantId: "set-up-workspace" } })),
  background: vi.fn(async () => ({ kind: "started" })), policy: vi.fn(() => "auto"),
}));
vi.mock("convex/browser", () => ({ ConvexHttpClient: class { setAuth() {} query = mocks.query; } }));
vi.mock("../../../../config.js", () => ({ HOSTED_MODE: false, LOCAL_HARNESS_ENABLED: true }));
vi.mock("../acting-user.js", () => ({ resolveLocalHarnessActor: mocks.actor }));
vi.mock("../authorization.js", () => ({ readLocalHarnessAuthorization: mocks.authorization, authorizeLocalHarness: mocks.authorize }));
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
import { ensureLocalHarnessTarget } from "../readiness.js";
import { Hono } from "hono";
import routes from "../../../../routes/v1/local-execution.js";
import { v1OnError } from "../../../../routes/v1/envelope.js";
const actor = { credential: "authkit" as const, subject: "user", userId: "authkit:user" };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CONVEX_URL", "https://example.convex.cloud");
  mocks.actor.mockResolvedValue({ ok: true, actor });
  mocks.query.mockImplementation(async (name: string) => name === "projects:getMyProjects" ? [{ _id: "project" }] : { externalId: "user" });
  mocks.rollout.mockResolvedValue(true);
  mocks.authorization.mockResolvedValue({ workspaceGrantId: "saved-workspace", unattended: true });
  mocks.status.mockResolvedValue({ state: "ready", runtimeRoot: "/runtime", packVersion: "1" });
  mocks.register.mockResolvedValue({ ok: true, keyId: "registered" });
  mocks.grant.mockResolvedValue({ grantId: "fresh-grant", token: "fresh-token", expiresAt: "2099-01-01" });
});

const app = new Hono();
app.onError(v1OnError);
app.route('/', routes);
const post = (body = { harnessId: 'codex', allowUnattended: true, workspaceGrantId: 'saved-workspace' }) =>
  app.request('/projects/project/local-execution-grants', {
    method: 'POST', headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
it('never creates durable authorization or a workspace from an API call', async () => {
  mocks.authorization.mockResolvedValue(null);
  const response = await post();
  expect(response.status).toBe(403);
  expect(mocks.authorize).not.toHaveBeenCalled();
  expect(mocks.workspace).not.toHaveBeenCalled();
  expect(mocks.status).not.toHaveBeenCalled();
  expect(mocks.grant).not.toHaveBeenCalled();
});
it('refuses a different registered workspace before runtime work', async () => {
  const response = await post({ harnessId: 'codex', allowUnattended: true, workspaceGrantId: 'another-workspace' });
  expect(response.status).toBe(403);
  expect(mocks.status).not.toHaveBeenCalled();
  expect(mocks.grant).not.toHaveBeenCalled();
});
it('refuses callers without verified member identity', async () => {
  mocks.actor.mockResolvedValue({ ok: false, message: 'Verified member required' });
  expect((await post()).status).toBe(401);
  expect(mocks.authorization).not.toHaveBeenCalled();
});
it('refuses disabled unattended authorization', async () => {
  mocks.authorization.mockResolvedValue({ workspaceGrantId: 'saved-workspace', unattended: false });
  expect((await post()).status).toBe(403);
  expect(mocks.grant).not.toHaveBeenCalled();
});
it('renews only the authorized workspace without another setup write', async () => {
  mocks.grant.mockResolvedValue({ token: 'a-valid-capability-token', grantId: 'grant', expiresAt: '2099-01-01' });
  const response = await post();
  expect(response.status).toBe(200);
  expect(mocks.grant).toHaveBeenCalledWith(expect.objectContaining({ workspaceGrantId: 'saved-workspace', scope: 'unattended' }), expect.any(Object));
  expect(mocks.authorize).not.toHaveBeenCalled();
  expect(mocks.workspace).not.toHaveBeenCalled();
});

it('supports server-created eval scratch without a captured actor', async () => {
  const ready = await ensureLocalHarnessTarget({ bearer: 'session', projectId: 'project', harnessId: 'codex', scope: 'unattended', runWorkspaceGrantId: 'eval-scratch' });
  expect(ready.target.workspaceGrantId).toBe('eval-scratch');
  expect(mocks.actor).toHaveBeenCalled();
  expect(mocks.authorize).not.toHaveBeenCalled();
});
it('does not accept the server scratch override from HTTP', async () => {
  const response = await app.request('/projects/project/local-execution-grants', {
    method: 'POST', headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
    body: JSON.stringify({ harnessId: 'codex', allowUnattended: true, workspaceGrantId: 'saved-workspace', runWorkspaceGrantId: 'elsewhere' }),
  });
  expect(response.status).toBe(400);
  expect(mocks.grant).not.toHaveBeenCalled();
});
