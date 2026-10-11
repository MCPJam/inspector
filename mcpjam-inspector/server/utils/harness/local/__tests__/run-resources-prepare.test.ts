import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Unattended local preparation, per harness: one private scratch folder per
 * eval iteration or swarm session, a target minted for THAT harness, and the
 * scratch plus the session's own state (where its private TMPDIR lives)
 * removed when the run ends — never at per-turn teardown.
 */
const env = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => env.home };
});
vi.mock("../readiness.js", () => ({
  ensureLocalHarnessTarget: vi.fn(async (args: { harnessId: string; workspaceGrantId: string }) => ({
    target: {
      kind: "local-native", machineId: "m", runtimeId: `rt-${args.harnessId}`,
      workspaceGrantId: args.workspaceGrantId, permissionProfile: "unrestricted",
      policyVersion: "v1", grantToken: "g", actingUserId: "u",
    },
  })),
  localHarnessAccountEnabled: vi.fn(async () => true),
}));
vi.mock("../grants.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../grants.js")>();
  return {
    ...actual,
    registerWorkspaceGrant: vi.fn(async () => ({ ok: true, grant: { workspaceGrantId: "scratch-grant-1" } })),
    forgetWorkspaceGrant: vi.fn(async () => {}),
  };
});
vi.mock("../session-registry.js", () => ({ stopLocalHarnessWorkspace: vi.fn(async () => true) }));

import { prepareLocalHarnessRun } from "../run-resources.js";
import { ensureLocalHarnessTarget } from "../readiness.js";
import { forgetWorkspaceGrant } from "../grants.js";
import { stopLocalHarnessWorkspace } from "../session-registry.js";

const exists = (path: string) => stat(path).then(() => true, () => false);

describe.skipIf(process.platform === "win32")("prepareLocalHarnessRun", () => {
  beforeEach(async () => {
    env.home = await mkdtemp(join(tmpdir(), "mcpjam-prepare-"));
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await rm(env.home, { recursive: true, force: true });
  });

  it("mints an unattended Codex target over a private scratch folder and removes it all at the end", async () => {
    const run = await prepareLocalHarnessRun({ bearer: "b", projectId: "p", harnessId: "codex" });
    expect(ensureLocalHarnessTarget).toHaveBeenCalledWith(
      expect.objectContaining({ harnessId: "codex", scope: "unattended", workspaceGrantId: "scratch-grant-1" }),
    );
    expect(run.target).toMatchObject({ runtimeId: "rt-codex", permissionProfile: "unrestricted" });
    expect(run.target.localSessionId).toMatch(/^local-/);

    const scratchRoot = join(env.home, ".mcpjam", "harness-workspaces", "scratch");
    const [scratch] = await readdir(scratchRoot);
    expect(scratch).toMatch(/^run-/);
    // The session's state dir holds its private TMPDIR; simulate what a turn
    // leaves behind in both places.
    const stateDir = join(env.home, ".mcpjam", "harness-local-sessions", run.target.localSessionId);
    await mkdir(join(stateDir, "tmp"), { recursive: true });
    await writeFile(join(stateDir, "tmp", "leftover"), "x");
    await writeFile(join(scratchRoot, scratch!, "output.txt"), "x");

    await run.cleanup();
    expect(stopLocalHarnessWorkspace).toHaveBeenCalledWith("scratch-grant-1");
    expect(await exists(join(scratchRoot, scratch!))).toBe(false);
    expect(await exists(stateDir)).toBe(false);
    expect(forgetWorkspaceGrant).toHaveBeenCalledWith("scratch-grant-1");
  });

  it("keeps the scratch folder while a process it started may still be running", async () => {
    vi.mocked(stopLocalHarnessWorkspace).mockResolvedValueOnce(false);
    const run = await prepareLocalHarnessRun({ bearer: "b", projectId: "p", harnessId: "codex" });
    const scratchRoot = join(env.home, ".mcpjam", "harness-workspaces", "scratch");
    const [scratch] = await readdir(scratchRoot);
    await run.cleanup();
    // A survivor still owns it: deleting under it would race the process, so
    // the janitor reclaims it once the process is gone.
    expect(await exists(join(scratchRoot, scratch!))).toBe(true);
    expect(forgetWorkspaceGrant).not.toHaveBeenCalled();
  });

  it("removes the scratch folder when preparation itself fails", async () => {
    vi.mocked(ensureLocalHarnessTarget).mockRejectedValueOnce(new Error("Codex is not set up on this machine"));
    await expect(
      prepareLocalHarnessRun({ bearer: "b", projectId: "p", harnessId: "codex" }),
    ).rejects.toThrow(/not set up/);
    const scratchRoot = join(env.home, ".mcpjam", "harness-workspaces", "scratch");
    expect(await readdir(scratchRoot)).toEqual([]);
    expect(forgetWorkspaceGrant).toHaveBeenCalledWith("scratch-grant-1");
  });
});
