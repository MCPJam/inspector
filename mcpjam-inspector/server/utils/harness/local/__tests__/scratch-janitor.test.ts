import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const mocks = vi.hoisted(() => ({ probe: vi.fn(), records: vi.fn(), forget: vi.fn(), prune: vi.fn() }));
vi.mock("../process-identity.js", () => ({ probeProcess: mocks.probe }));
vi.mock("../process-registry.js", () => ({ listProcessRecords: mocks.records }));
vi.mock("../grants.js", async importOriginal => ({ ...await importOriginal<typeof import('../grants.js')>(), forgetWorkspaceGrant: mocks.forget, pruneExpiredHarnessGrants: mocks.prune }));
import { recordScratchOwner, scratchRoot, sweepLocalHarnessScratch } from "../scratch-janitor.js";
let home: string;
beforeEach(async () => {
  vi.clearAllMocks();
  home = await mkdtemp(join(tmpdir(), "scratch-janitor-")); vi.stubEnv("HOME", home);
  mocks.probe.mockResolvedValue({ state: "alive", identity: "owner" }); mocks.records.mockResolvedValue([]);
  await mkdir(join(scratchRoot(), "run-test"), { recursive: true });
  await writeFile(join(scratchRoot(), "run-test", "proof"), "keep");
  await recordScratchOwner("run-test", "grant");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });
it.each(["alive", "unknown"])("retains work when the owner is %s", async state => {
  mocks.probe.mockResolvedValue({ state, identity: "owner" });
  await sweepLocalHarnessScratch();
  expect(await readFile(join(scratchRoot(), "run-test", "proof"), "utf8")).toBe("keep");
  expect(mocks.forget).not.toHaveBeenCalled();
});
it("retains work while the child tree still has a registry record", async () => {
  mocks.probe.mockResolvedValue({ state: "gone" }); mocks.records.mockResolvedValue([{ workspaceGrantId: "grant" }]);
  await sweepLocalHarnessScratch(); expect(mocks.forget).not.toHaveBeenCalled();
});
it("removes scratch and credentials only after owner and child tree are gone", async () => {
  mocks.probe.mockResolvedValue({ state: "gone" });
  await sweepLocalHarnessScratch();
  await expect(readFile(join(scratchRoot(), "run-test", "proof"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(mocks.forget).toHaveBeenCalledWith("grant"); expect(mocks.prune).toHaveBeenCalled();
});
