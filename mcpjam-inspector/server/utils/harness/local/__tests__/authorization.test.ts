import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeLocalHarness, readLocalHarnessAuthorization, revokeLocalHarnessAuthorization } from "../authorization.js";
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
