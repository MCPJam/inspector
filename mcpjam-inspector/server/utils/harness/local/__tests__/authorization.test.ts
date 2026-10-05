import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeLocalHarness, readLocalHarnessAuthorization, revokeLocalHarnessAuthorization, updateAuthorizedWorkspace, acknowledgeLocalHarnessAutoApprove } from "../authorization.js";
import { LOCAL_HARNESS_POLICY_VERSION } from "../targets.js";
import { localHarnessStateRoot } from "../grants.js";

let root: string;
const binding = { userId: "user", machineId: "machine", projectId: "project", workspaceGrantId: "workspace" };
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "local-authorize-")); vi.stubEnv("HOME", root); });
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
describe("durable local authorization", () => {
  it("survives execution credential expiry and is bound to member, project and machine", async () => {
    await authorizeLocalHarness(binding);
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 30 * 24 * 60 * 60 * 1000);
    expect(await readLocalHarnessAuthorization("user", "machine", "project")).toMatchObject({ workspaceGrantId: "workspace", unattended: true });
    expect(await readLocalHarnessAuthorization("other", "machine", "project")).toBeNull();
    expect(await readLocalHarnessAuthorization("user", "other", "project")).toBeNull();
    expect(await readLocalHarnessAuthorization("user", "machine", "other")).toBeNull();
  });
  it("serializes parallel setup and revokes only the selected project", async () => {
    await Promise.all([authorizeLocalHarness(binding), authorizeLocalHarness({ ...binding, projectId: "second" })]);
    await revokeLocalHarnessAuthorization("user", "project");
    expect(await readLocalHarnessAuthorization("user", "machine", "project")).toBeNull();
    expect(await readLocalHarnessAuthorization("user", "machine", "second")).not.toBeNull();
  });
  it("fails closed on a damaged store", async () => {
    await authorizeLocalHarness(binding);
    await writeFile(join(localHarnessStateRoot(), "authorizations.json"), "broken");
    await expect(readLocalHarnessAuthorization("user", "machine", "project")).rejects.toThrow("could not be read");
  });
});

describe("one authorization store shared by every Inspector version", () => {
  const storePath = () => join(localHarnessStateRoot(), "authorizations.json");
  /** How a build from before Codex reads the store: no harnessId at all. */
  async function legacyRead(userId: string, machineId: string, projectId: string) {
    const raw = JSON.parse(await readFile(storePath(), "utf8")) as {
      authorizations: Array<{ userId: string; machineId: string; projectId: string }>;
    };
    return raw.authorizations.find((a) => a.userId === userId && a.machineId === machineId && a.projectId === projectId) ?? null;
  }

  it("never lets an older build read a Codex authorization as Claude Code", async () => {
    await authorizeLocalHarness({ ...binding, harnessId: "codex" });
    expect(await legacyRead("user", "machine", "project")).toBeNull();
    expect(await readLocalHarnessAuthorization("user", "machine", "project", "codex")).not.toBeNull();
    expect(await readLocalHarnessAuthorization("user", "machine", "project")).toBeNull();
  });

  it("keeps Claude Code records in the shape older builds read", async () => {
    await authorizeLocalHarness(binding);
    const legacy = await legacyRead("user", "machine", "project");
    expect(legacy).toMatchObject({ workspaceGrantId: "workspace", unattended: true });
    expect(legacy).not.toHaveProperty("harnessId");
  });

  it("reads a store written before Codex as Claude Code", async () => {
    await authorizeLocalHarness(binding); // creates the state directory
    await writeFile(storePath(), JSON.stringify({
      version: 1,
      authorizations: [{ ...binding, policyVersion: LOCAL_HARNESS_POLICY_VERSION, authorizedAt: new Date().toISOString(), unattended: true }],
    }));
    expect(await readLocalHarnessAuthorization("user", "machine", "project")).toMatchObject({ harnessId: "claude-code" });
    expect(await readLocalHarnessAuthorization("user", "machine", "project", "codex")).toBeNull();
  });

  it("isolates writes per harness", async () => {
    await authorizeLocalHarness(binding);
    await authorizeLocalHarness({ ...binding, harnessId: "codex", workspaceGrantId: "codex-workspace" });
    await updateAuthorizedWorkspace({ ...binding, harnessId: "codex", workspaceGrantId: "moved" });
    expect(await readLocalHarnessAuthorization("user", "machine", "project")).toMatchObject({ workspaceGrantId: "workspace" });
    expect(await readLocalHarnessAuthorization("user", "machine", "project", "codex")).toMatchObject({ workspaceGrantId: "moved" });
  });

  it("moves a Codex record an earlier build left in the legacy list", async () => {
    await authorizeLocalHarness(binding);
    await writeFile(storePath(), JSON.stringify({
      version: 1,
      authorizations: [{ ...binding, harnessId: "codex", policyVersion: LOCAL_HARNESS_POLICY_VERSION, authorizedAt: new Date().toISOString(), unattended: true }],
    }));
    expect(await readLocalHarnessAuthorization("user", "machine", "project", "codex")).not.toBeNull();
    await authorizeLocalHarness({ ...binding, projectId: "second" }); // any write
    expect(await legacyRead("user", "machine", "project")).toBeNull();
    expect(await readLocalHarnessAuthorization("user", "machine", "project", "codex")).not.toBeNull();
  });
});

it("auto approval consent is scoped, survives renewal, and is cleared by forgetting", async () => {
  await authorizeLocalHarness(binding);
  await acknowledgeLocalHarnessAutoApprove({ ...binding, harnessId: "claude-code" });
  expect((await readLocalHarnessAuthorization("user", "machine", "project"))?.autoApproveAcknowledgedAt).toBeTruthy();
  expect(await readLocalHarnessAuthorization("user", "machine", "project", "codex")).toBeNull();
  await authorizeLocalHarness(binding);
  expect((await readLocalHarnessAuthorization("user", "machine", "project"))?.autoApproveAcknowledgedAt).toBeTruthy();
  await revokeLocalHarnessAuthorization("user", "project");
  await authorizeLocalHarness(binding);
  expect((await readLocalHarnessAuthorization("user", "machine", "project"))?.autoApproveAcknowledgedAt).toBeUndefined();
});
it("cannot acknowledge absent authorization or an old policy", async () => {
  await expect(acknowledgeLocalHarnessAutoApprove({ ...binding, harnessId: "claude-code" })).rejects.toThrow("Set up");
  await authorizeLocalHarness(binding);
  const path = join(localHarnessStateRoot(), "authorizations.json");
  const state = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8"));
  state.authorizations[0].policyVersion = "old";
  await writeFile(path, JSON.stringify(state));
  await expect(acknowledgeLocalHarnessAutoApprove({ ...binding, harnessId: "claude-code" })).rejects.toThrow("Set up");
});

it("keeps consent separate for harnesses sharing one project", async () => {
  await authorizeLocalHarness(binding);
  await authorizeLocalHarness({ ...binding, harnessId: "codex" });
  await acknowledgeLocalHarnessAutoApprove({ ...binding, harnessId: "codex" });
  expect((await readLocalHarnessAuthorization("user", "machine", "project"))?.autoApproveAcknowledgedAt).toBeUndefined();
  expect((await readLocalHarnessAuthorization("user", "machine", "project", "codex"))?.autoApproveAcknowledgedAt).toBeTruthy();
});
