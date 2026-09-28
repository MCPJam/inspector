import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The local-harness control routes' CONTRACTS.
 *
 * Three of them are new and each replaces something that could not work:
 *
 *   - install ACKNOWLEDGES (202 + Location + Retry-After) instead of holding a
 *     request open for a ~200 MB download, which a proxy timeout, a sleeping
 *     laptop or a reload would silently end with the client unable to tell
 *     "still going" from "lost";
 *   - `useSuggested` registers the launch folder server-side, because the
 *     client never sees an absolute path and so cannot send one back;
 *   - consent compares the terms the user was SHOWN against the terms that are
 *     true now, and refuses to mint against a difference.
 */

const {
  startRuntimeInstallMock,
  readRuntimeInstallStatusMock,
  readVerifiedRuntimeStatusMock,
  registerWorkspaceGrantMock,
  resolveWorkspaceGrantMock,
  grantLocalHarnessConsentMock,
  getLocalMachineIdMock,
  resolveSuggestedWorkspaceMock,
  resolveManagedBundleMock,
  registerLocalInstanceMock,
  verifyAuthKitTokenMock,
  isComputersDataPlaneConfiguredMock,
} = vi.hoisted(() => ({
  startRuntimeInstallMock: vi.fn(),
  readRuntimeInstallStatusMock: vi.fn(),
  readVerifiedRuntimeStatusMock: vi.fn(),
  registerWorkspaceGrantMock: vi.fn(),
  resolveWorkspaceGrantMock: vi.fn(),
  grantLocalHarnessConsentMock: vi.fn(),
  getLocalMachineIdMock: vi.fn(),
  resolveSuggestedWorkspaceMock: vi.fn(),
  resolveManagedBundleMock: vi.fn(),
  registerLocalInstanceMock: vi.fn(),
  verifyAuthKitTokenMock: vi.fn(),
  isComputersDataPlaneConfiguredMock: vi.fn(),
}));

vi.mock("../../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../../config.js")>(
    "../../../config.js",
  );
  return { ...actual, LOCAL_HARNESS_ENABLED: true, HOSTED_MODE: false };
});

vi.mock("../../../utils/harness/local/runtime-install.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/harness/local/runtime-install.js")
  >("../../../utils/harness/local/runtime-install.js");
  return {
    ...actual,
    startRuntimeInstall: startRuntimeInstallMock,
    readRuntimeInstallStatus: readRuntimeInstallStatusMock,
    readVerifiedRuntimeStatus: readVerifiedRuntimeStatusMock,
    runtimeInstallRoot: () => "/tmp/runtime-root",
  };
});

vi.mock("../../../utils/harness/local/grants.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/harness/local/grants.js")
  >("../../../utils/harness/local/grants.js");
  return {
    ...actual,
    registerWorkspaceGrant: registerWorkspaceGrantMock,
    resolveWorkspaceGrant: resolveWorkspaceGrantMock,
    grantLocalHarnessConsent: grantLocalHarnessConsentMock,
    getLocalMachineId: getLocalMachineIdMock,
    revokeLocalHarnessGrants: vi.fn(async () => 0),
  };
});

vi.mock("../../../utils/harness/local/suggested-workspace.js", () => ({
  resolveSuggestedWorkspace: resolveSuggestedWorkspaceMock,
}));

vi.mock("../../../utils/harness/local/runtime-identity.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/harness/local/runtime-identity.js")
  >("../../../utils/harness/local/runtime-identity.js");
  return { ...actual, resolveManagedBundle: resolveManagedBundleMock };
});

vi.mock("../../../utils/harness/harness-model-broker.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/harness/harness-model-broker.js")
  >("../../../utils/harness/harness-model-broker.js");
  return { ...actual, registerLocalInstance: registerLocalInstanceMock };
});

vi.mock("../../../utils/harness/local/instance-key.js", () => ({
  readLocalInstanceIdentity: async () => ({
    machineId: "mach_1",
    publicKey: "pk",
  }),
  instanceKeyFingerprint: () => "fp",
  setRegisteredKeyId: vi.fn(),
}));

vi.mock("../../../services/authkit-jwt.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../services/authkit-jwt.js")
  >("../../../services/authkit-jwt.js");
  return { ...actual, verifyAuthKitToken: verifyAuthKitTokenMock };
});

vi.mock("../../../utils/computers/control-plane-client.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/computers/control-plane-client.js")
  >("../../../utils/computers/control-plane-client.js");
  return {
    ...actual,
    isComputersDataPlaneConfigured: isComputersDataPlaneConfiguredMock,
  };
});

// The bearer middleware is exercised elsewhere; here the point is the route's
// own logic, so the context is established directly and every request carries a
// verifiable AuthKit bearer.
vi.mock("../../../middleware/bearer-auth.js", () => ({
  bearerAuthMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock("../../../middleware/require-verified-auth.js", () => ({
  requireVerifiedAuth: () => async (_c: unknown, next: () => Promise<void>) =>
    next(),
}));
vi.mock("../../../middleware/origin-validation.js", () => ({
  isAllowedRequestOrigin: () => true,
}));

import localHarness from "../local-harness.js";

function createApp() {
  const app = new Hono();
  app.route("/api/mcp/local-harness", localHarness);
  return app;
}

const AUTH = { Authorization: "Bearer session", Origin: "http://localhost" };

const READY_STATUS = {
  state: "ready" as const,
  packVersion: "3.4.0",
  runtimeRoot: "/tmp/runtime-root/linux-x64/3.4.0",
  digest: `sha256:${"a".repeat(64)}`,
};

beforeEach(() => {
  vi.clearAllMocks();
  verifyAuthKitTokenMock.mockResolvedValue({ sub: "user_1" });
  readRuntimeInstallStatusMock.mockResolvedValue(READY_STATUS);
  readVerifiedRuntimeStatusMock.mockResolvedValue(READY_STATUS);
  resolveSuggestedWorkspaceMock.mockResolvedValue(null);
  isComputersDataPlaneConfiguredMock.mockReturnValue(false);
  resolveManagedBundleMock.mockResolvedValue({
    ok: true,
    runtime: {
      runtimeId: "rt_1",
      adapterVersion: "1.0.0",
      digest: `sha256:${"a".repeat(64)}`,
      vendorPackages: {},
    },
  });
  getLocalMachineIdMock.mockResolvedValue("mach_1");
  registerLocalInstanceMock.mockResolvedValue({ ok: true, keyId: "key_1" });
  resolveWorkspaceGrantMock.mockResolvedValue({
    ok: true,
    canonicalPath: "/home/dev/code/project",
  });
  grantLocalHarnessConsentMock.mockResolvedValue({
    grantId: "grant_1",
    token: "t".repeat(32),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
});

describe("GET /availability", () => {
  it("reports whether a CLOUD target exists at all on this server", async () => {
    // The one bit that decides whether the chip is a picker or an indicator. A
    // normal npx or Electron install has no computers data plane, so "This
    // machine" is not a choice — it is what this Inspector is.
    const response = await createApp().request(
      "/api/mcp/local-harness/availability",
      { headers: AUTH },
    );
    expect(await response.json()).toMatchObject({ hostedAvailable: false });

    isComputersDataPlaneConfiguredMock.mockReturnValue(true);
    const configured = await createApp().request(
      "/api/mcp/local-harness/availability",
      { headers: AUTH },
    );
    expect(await configured.json()).toMatchObject({ hostedAvailable: true });
  });

  it("names the expected pack before anything is installed", async () => {
    // So Details can say WHICH runtime is about to be downloaded. Approving a
    // named runtime and then fetching it is the whole shape of the flow.
    const response = await createApp().request(
      "/api/mcp/local-harness/availability",
      { headers: AUTH },
    );
    const body = (await response.json()) as { expectedPack: unknown };
    // Null in this checkout (no pack has been built), which is the honest
    // answer rather than an invented one — but the FIELD is always present.
    expect(body).toHaveProperty("expectedPack");
  });

  it("offers the launch folder, as a display string and nothing more", async () => {
    resolveSuggestedWorkspaceMock.mockResolvedValue({
      canonicalPath: "/home/dev/code/project",
      displayRoot: "~/code/project",
    });
    const response = await createApp().request(
      "/api/mcp/local-harness/availability",
      { headers: AUTH },
    );
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({
      suggestedWorkspace: { displayRoot: "~/code/project" },
    });
    // The absolute path stays on this side. It is local trusted state, and a
    // home directory carries the user's name on most machines.
    expect(body).not.toContain("/home/dev/code/project");
  });
});

describe("POST /runtime/install", () => {
  it("acknowledges with 202, Location and Retry-After", async () => {
    startRuntimeInstallMock.mockResolvedValue({
      kind: "started",
      attemptId: "att_1",
      status: { state: "downloading", packVersion: "3.4.0", percent: 0 },
    });

    const response = await createApp().request(
      "/api/mcp/local-harness/runtime/install",
      { method: "POST", headers: AUTH, body: "{}" },
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("Location")).toBe(
      "/api/mcp/local-harness/runtime/status",
    );
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(await response.json()).toMatchObject({
      state: "started",
      attemptId: "att_1",
    });
  });

  it("202s a JOIN too, so a second window polls rather than downloads", async () => {
    startRuntimeInstallMock.mockResolvedValue({
      kind: "joined",
      attemptId: "att_other",
      status: { state: "downloading", packVersion: "3.4.0", percent: 42 },
    });

    const response = await createApp().request(
      "/api/mcp/local-harness/runtime/install",
      { method: "POST", headers: AUTH, body: "{}" },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      state: "joined",
      attemptId: "att_other",
      status: { percent: 42 },
    });
  });

  it("200s a verified runtime without downloading anything", async () => {
    startRuntimeInstallMock.mockResolvedValue({
      kind: "ready",
      status: READY_STATUS,
    });

    const response = await createApp().request(
      "/api/mcp/local-harness/runtime/install",
      { method: "POST", headers: AUTH, body: "{}" },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "ready" });
  });

  it("forwards the approved pack, and 409s when it no longer matches", async () => {
    // A server that updated between the dialog opening and the click would
    // otherwise fetch a runtime whose identity the user was never shown — and
    // consent binds to that identity.
    startRuntimeInstallMock.mockResolvedValue({
      kind: "refused",
      reason: "this Inspector now expects a different runtime",
      status: {
        state: "failed",
        packVersion: "3.5.0",
        reason: "verification",
        message: "the approved runtime was 3.4.0",
      },
    });

    const response = await createApp().request(
      "/api/mcp/local-harness/runtime/install",
      {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          expectedPack: { packVersion: "3.4.0", treeDigest: "sha256:old" },
        }),
      },
    );

    expect(startRuntimeInstallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPack: { packVersion: "3.4.0", treeDigest: "sha256:old" },
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      reason: "expected-pack-changed",
    });
  });

  it("400s a machine with no pack to install", async () => {
    startRuntimeInstallMock.mockResolvedValue({
      kind: "refused",
      reason: "linux-riscv64 has no local harness runtime",
      status: { state: "unsupported-platform", message: "no pack" },
    });

    const response = await createApp().request(
      "/api/mcp/local-harness/runtime/install",
      { method: "POST", headers: AUTH, body: "{}" },
    );
    expect(response.status).toBe(400);
  });
});

describe("GET /runtime/status", () => {
  it("never starts work", async () => {
    await createApp().request("/api/mcp/local-harness/runtime/status", {
      headers: AUTH,
    });
    // A poll that could download would turn a reload or a component remount
    // into a 200 MB fetch nobody asked for.
    expect(startRuntimeInstallMock).not.toHaveBeenCalled();
  });

  it("asks the cheap question by default and the expensive one on request", async () => {
    const app = createApp();
    await app.request("/api/mcp/local-harness/runtime/status", { headers: AUTH });
    expect(readVerifiedRuntimeStatusMock).not.toHaveBeenCalled();

    await app.request("/api/mcp/local-harness/runtime/status?verify=1", {
      headers: AUTH,
    });
    expect(readVerifiedRuntimeStatusMock).toHaveBeenCalled();
  });
});

describe("POST /workspace-grant", () => {
  beforeEach(() => {
    registerWorkspaceGrantMock.mockResolvedValue({
      ok: true,
      grant: {
        workspaceGrantId: "ws_1",
        canonicalPath: "/home/dev/code/project",
      },
    });
  });

  it("registers the suggested folder server-side, re-resolving it", async () => {
    // The client never sees an absolute path, so it cannot send one back.
    // "The suggested folder" has to mean whatever the server resolves now.
    resolveSuggestedWorkspaceMock.mockResolvedValue({
      canonicalPath: "/home/dev/code/project",
      displayRoot: "~/code/project",
    });

    const response = await createApp().request(
      "/api/mcp/local-harness/workspace-grant",
      {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ useSuggested: true }),
      },
    );

    expect(response.status).toBe(200);
    expect(registerWorkspaceGrantMock).toHaveBeenCalledWith(
      "/home/dev/code/project",
    );
    expect(await response.json()).toMatchObject({ workspaceGrantId: "ws_1" });
  });

  it("re-validates rather than trusting what it offered a moment ago", async () => {
    // The suggestion is gone — a deleted directory, or a server restarted
    // without the variable. Registering anything here would be registering a
    // folder nobody can name.
    resolveSuggestedWorkspaceMock.mockResolvedValue(null);

    const response = await createApp().request(
      "/api/mcp/local-harness/workspace-grant",
      {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ useSuggested: true }),
      },
    );

    expect(response.status).toBe(400);
    expect(registerWorkspaceGrantMock).not.toHaveBeenCalled();
  });

  it("refuses an ambiguous request naming both", async () => {
    const response = await createApp().request(
      "/api/mcp/local-harness/workspace-grant",
      {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ useSuggested: true, path: "/somewhere/else" }),
      },
    );
    expect(response.status).toBe(400);
    expect(registerWorkspaceGrantMock).not.toHaveBeenCalled();
  });

  it("still takes an explicit path from a same-origin caller", async () => {
    const response = await createApp().request(
      "/api/mcp/local-harness/workspace-grant",
      {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ path: "/home/dev/code/project" }),
      },
    );
    expect(response.status).toBe(200);
    expect(registerWorkspaceGrantMock).toHaveBeenCalledWith(
      "/home/dev/code/project",
    );
  });
});

describe("POST /consent/grant", () => {
  const grantBody = (expect_?: Record<string, unknown>) =>
    JSON.stringify({
      projectId: "project-1",
      workspaceGrantId: "ws_1",
      ...(expect_ ? { expect: expect_ } : {}),
    });

  const APPROVED = {
    machineId: "mach_1",
    packVersion: "3.4.0",
    treeDigest: `sha256:${"a".repeat(64)}`,
    permissionProfile: "workspace-edits",
    policyVersion: "local-harness-policy-2026-09-01",
  };

  it("mints when what was approved is still true", async () => {
    const response = await createApp().request(
      "/api/mcp/local-harness/consent/grant",
      { method: "POST", headers: AUTH, body: grantBody(APPROVED) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ grantId: "grant_1" });
  });

  it.each([
    ["the machine", { machineId: "mach_other" }],
    ["the pack version", { packVersion: "3.3.0" }],
    ["the runtime digest", { treeDigest: `sha256:${"b".repeat(64)}` }],
    ["the permission profile", { permissionProfile: "unrestricted" }],
    ["the policy", { policyVersion: "local-harness-policy-2020-01-01" }],
  ])("409s and mints nothing when %s changed", async (_label, drift) => {
    const response = await createApp().request(
      "/api/mcp/local-harness/consent/grant",
      {
        method: "POST",
        headers: AUTH,
        body: grantBody({ ...APPROVED, ...drift }),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      reason: "consent-context-changed",
      changed: [Object.keys(drift)[0]],
    });
    // The point of the check: nothing was bound to terms the user never saw.
    expect(grantLocalHarnessConsentMock).not.toHaveBeenCalled();
  });

  it("returns the CURRENT terms so the dialog can re-ask without a round trip", async () => {
    const response = await createApp().request(
      "/api/mcp/local-harness/consent/grant",
      {
        method: "POST",
        headers: AUTH,
        body: grantBody({ ...APPROVED, packVersion: "3.3.0" }),
      },
    );
    expect(await response.json()).toMatchObject({
      current: { packVersion: "3.4.0", permissionProfile: "workspace-edits" },
    });
  });

  it("treats an omitted expectation as a question, not a mismatch", async () => {
    // A caller that never captured expectations is ASKING for the terms. It
    // gets them in the response; it does not get a 409 for not knowing them.
    const response = await createApp().request(
      "/api/mcp/local-harness/consent/grant",
      { method: "POST", headers: AUTH, body: grantBody() },
    );
    expect(response.status).toBe(200);
  });

  it("binds the server-resolved actor, never one the body named", async () => {
    const response = await createApp().request(
      "/api/mcp/local-harness/consent/grant",
      {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          projectId: "project-1",
          workspaceGrantId: "ws_1",
          userId: "somebody-else",
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(grantLocalHarnessConsentMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "authkit:user_1" }),
    );
  });

  it("409s before minting when no runtime is installed", async () => {
    readRuntimeInstallStatusMock.mockResolvedValue({
      state: "absent",
      packVersion: "3.4.0",
    });
    const response = await createApp().request(
      "/api/mcp/local-harness/consent/grant",
      { method: "POST", headers: AUTH, body: grantBody(APPROVED) },
    );
    expect(response.status).toBe(409);
    expect(grantLocalHarnessConsentMock).not.toHaveBeenCalled();
  });
});
