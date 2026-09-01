import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  LOCAL_HARNESS_POLICY_VERSION,
  type LocalPermissionProfile,
} from "../targets.js";
import {
  getLocalMachineId,
  grantLocalHarnessConsent,
  hashGrantBinding,
  pruneExpiredHarnessGrants,
  registerWorkspaceGrant,
  resolveWorkspaceGrant,
  revokeLocalHarnessGrants,
  verifyLocalHarnessGrant,
  type HarnessGrantBinding,
} from "../grants.js";

let base: string;
let workspace: string;
const realHome = process.env.HOME;

function binding(
  overrides: Partial<HarnessGrantBinding> = {}
): HarnessGrantBinding {
  return {
    userId: "user_1",
    machineId: "mach_1",
    projectId: "proj_1",
    workspaceGrantId: "ws_1",
    harnessId: "claude-code",
    targetKind: "local-native",
    runtimeId: "rt_1",
    permissionProfile: "workspace-edits",
    policyVersion: LOCAL_HARNESS_POLICY_VERSION,
    ...overrides,
  };
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mcpjam-grants-")));
  process.env.HOME = base;
  workspace = join(base, "project");
  await mkdir(workspace, { recursive: true });
});

afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
});

beforeEach(async () => {
  await revokeLocalHarnessGrants();
});

describe("workspace grants", () => {
  it("returns an opaque id, never the path, and canonicalizes the selection", async () => {
    const linked = join(base, "project-link");
    await symlink(workspace, linked).catch(() => {});
    const result = await registerWorkspaceGrant(linked);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.workspaceGrantId).toMatch(/^ws_/);
    expect(result.grant.workspaceGrantId).not.toContain(workspace);
    // The link and the target register as the SAME grant, because the
    // canonical path is what authorization is about.
    expect(result.grant.canonicalPath).toBe(workspace);
    const direct = await registerWorkspaceGrant(workspace);
    expect(direct.ok && direct.grant.workspaceGrantId).toBe(
      result.grant.workspaceGrantId
    );
  });

  it("resolves an id back to its canonical path only inside this process", async () => {
    const result = await registerWorkspaceGrant(workspace);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await expect(
      resolveWorkspaceGrant(result.grant.workspaceGrantId)
    ).resolves.toEqual({ ok: true, canonicalPath: workspace });
  });

  it("refuses an unknown id", async () => {
    await expect(resolveWorkspaceGrant("ws_nope")).resolves.toMatchObject({
      ok: false,
    });
  });

  it("refuses a file, a missing path, the home directory, and the root", async () => {
    const { writeFile } = await import("node:fs/promises");
    const file = join(base, "not-a-dir.txt");
    await writeFile(file, "x");
    await expect(registerWorkspaceGrant(file)).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/not a directory/),
    });
    await expect(registerWorkspaceGrant(join(base, "nope"))).resolves.toMatchObject({
      ok: false,
    });
    await expect(registerWorkspaceGrant(base)).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/project directory/),
    });
    await expect(registerWorkspaceGrant("/")).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/project directory/),
    });
  });

  it("drops malformed persisted records instead of throwing out of verify", async () => {
    // Local state can be hand-edited or truncated. A non-hex `tokenHash` would
    // make `Buffer.from` throw out of a function whose contract is to RETURN a
    // verification result, and an unparseable `expiresAt` would let
    // verification treat a grant as live while pruning removed it.
    const { mkdir, writeFile } = await import("node:fs/promises");
    const dir = join(base, ".mcpjam", "harness-local");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(dir, "grants.json"),
      JSON.stringify({
        version: 1,
        workspaces: [{ nonsense: true }],
        harnessGrants: [
          { grantId: "g1", tokenHash: 42, bindingHash: "x", expiresAt: "soon" },
          { grantId: "g2", tokenHash: "zz", bindingHash: "x", expiresAt: "nope" },
          null,
        ],
      })
    );
    await expect(
      verifyLocalHarnessGrant("x".repeat(64), binding())
    ).resolves.toMatchObject({ ok: false, reason: "absent" });
    await expect(resolveWorkspaceGrant("ws_1")).resolves.toMatchObject({
      ok: false,
    });
    await expect(pruneExpiredHarnessGrants()).resolves.toBe(0);
  });
});

describe("harness consent", () => {
  it("verifies a capability against the exact terms it was minted for", async () => {
    const { token } = await grantLocalHarnessConsent(binding());
    await expect(verifyLocalHarnessGrant(token, binding())).resolves.toMatchObject({
      ok: true,
    });
  });

  it("stores only a hash — the plaintext is returned once and never persisted", async () => {
    const { token } = await grantLocalHarnessConsent(binding());
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(
      join(base, ".mcpjam", "harness-local", "grants.json"),
      "utf8"
    );
    expect(raw).not.toContain(token);
  });

  it("rejects an absent or malformed capability", async () => {
    await expect(verifyLocalHarnessGrant(undefined, binding())).resolves.toMatchObject({
      reason: "invalid",
    });
    await expect(verifyLocalHarnessGrant("short", binding())).resolves.toMatchObject({
      reason: "invalid",
    });
    await expect(
      verifyLocalHarnessGrant("x".repeat(64), binding())
    ).resolves.toMatchObject({ reason: "absent" });
  });

  const drifts: Array<[string, Partial<HarnessGrantBinding>]> = [
    ["a different user", { userId: "user_2" }],
    ["a different machine", { machineId: "mach_2" }],
    ["a different project", { projectId: "proj_2" }],
    ["a different workspace", { workspaceGrantId: "ws_2" }],
    ["a different harness", { harnessId: "codex" }],
    ["a different target mode", { targetKind: "local-isolated" }],
    ["a different isolation backend", { backend: "linux-bwrap" }],
    ["a replaced runtime", { runtimeId: "rt_2" }],
    [
      "a widened permission profile",
      { permissionProfile: "unrestricted" as LocalPermissionProfile },
    ],
  ];

  it.each(drifts)("refuses the same capability under %s", async (_label, drift) => {
    const { token } = await grantLocalHarnessConsent(binding());
    await expect(
      verifyLocalHarnessGrant(token, binding(drift))
    ).resolves.toMatchObject({ reason: "binding-mismatch" });
  });

  it("refuses a grant minted under a superseded policy version", async () => {
    const stale = binding({ policyVersion: "local-harness-policy-1999-01-01" });
    const { token } = await grantLocalHarnessConsent(stale);
    const result = await verifyLocalHarnessGrant(token, stale);
    expect(result).toMatchObject({ reason: "binding-mismatch" });
    expect((result as { message: string }).message).toMatch(/terms changed/);
  });

  it("expires", async () => {
    const now = Date.now();
    const { token } = await grantLocalHarnessConsent(binding(), {
      ttlMs: 1_000,
      now,
    });
    await expect(
      verifyLocalHarnessGrant(token, binding(), { now: now + 2_000 })
    ).resolves.toMatchObject({ reason: "expired" });
  });

  it("rotates rather than accumulating when the same terms are re-consented", async () => {
    const first = await grantLocalHarnessConsent(binding());
    const second = await grantLocalHarnessConsent(binding());
    await expect(verifyLocalHarnessGrant(first.token, binding())).resolves.toMatchObject(
      { ok: false }
    );
    await expect(
      verifyLocalHarnessGrant(second.token, binding())
    ).resolves.toMatchObject({ ok: true });
  });

  it("revokes by grant id, by binding, and wholesale", async () => {
    const a = await grantLocalHarnessConsent(binding());
    expect(await revokeLocalHarnessGrants({ grantId: a.grantId })).toBe(1);
    await expect(verifyLocalHarnessGrant(a.token, binding())).resolves.toMatchObject({
      ok: false,
    });

    const b = await grantLocalHarnessConsent(binding());
    expect(await revokeLocalHarnessGrants({ binding: binding() })).toBe(1);
    await expect(verifyLocalHarnessGrant(b.token, binding())).resolves.toMatchObject({
      ok: false,
    });

    await grantLocalHarnessConsent(binding());
    await grantLocalHarnessConsent(binding({ projectId: "proj_2" }));
    expect(await revokeLocalHarnessGrants()).toBe(2);
  });

  it("prunes expired grants", async () => {
    const now = Date.now();
    await grantLocalHarnessConsent(binding(), { ttlMs: 1_000, now });
    expect(await pruneExpiredHarnessGrants(now + 2_000)).toBe(1);
  });

  it("hashes bindings by value, not by object identity or key order", () => {
    const a: HarnessGrantBinding = binding();
    const b: HarnessGrantBinding = {
      policyVersion: a.policyVersion,
      permissionProfile: a.permissionProfile,
      runtimeId: a.runtimeId,
      targetKind: a.targetKind,
      harnessId: a.harnessId,
      workspaceGrantId: a.workspaceGrantId,
      projectId: a.projectId,
      machineId: a.machineId,
      userId: a.userId,
    };
    expect(hashGrantBinding(a)).toBe(hashGrantBinding(b));
  });
});

describe("machine identity", () => {
  it("is stable across calls and is not derived from hardware", async () => {
    const first = await getLocalMachineId();
    expect(first).toMatch(/^mach_/);
    await expect(getLocalMachineId()).resolves.toBe(first);
  });
});
