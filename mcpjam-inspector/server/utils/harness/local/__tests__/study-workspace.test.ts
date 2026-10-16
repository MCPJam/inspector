import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ probe: vi.fn(), stop: vi.fn() }));
vi.mock("../process-identity.js", () => ({ probeProcess: mocks.probe }));
vi.mock("../session-registry.js", () => ({
  stopLocalHarnessWorkspace: mocks.stop,
}));
vi.mock("../supervised-provider.js", () => ({
  sessionStateDirFor: (root: string, id: string) => join(root, "sessions", id),
}));
import { prepareLocalStudyWorkspace } from "../study-workspace.js";
import {
  grantLocalHarnessConsent,
  resolveWorkspaceGrant,
  verifyLocalHarnessGrant,
} from "../grants.js";
import { LOCAL_HARNESS_POLICY_VERSION } from "../targets.js";

const owner = {
  userId: "participant-a",
  projectId: "project-a",
  study: { scenarioId: "study-a", accessVersion: 1, chatSessionId: "chat-a" },
};
let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "study-workspace-"));
  vi.stubEnv("HOME", home);
  mocks.probe.mockResolvedValue({ state: "alive", identity: "owner-a" });
  mocks.stop.mockResolvedValue(true);
});
afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});
async function pathFor(id: string) {
  const workspace = await resolveWorkspaceGrant(id);
  if (!workspace.ok) throw new Error(workspace.message);
  return workspace.canonicalPath;
}

it("retains files and runtime identity for the next turn", async () => {
  const first = await prepareLocalStudyWorkspace(owner);
  const path = await pathFor(first.workspaceGrantId);
  await writeFile(join(path, "proof"), "first turn");
  const next = await prepareLocalStudyWorkspace(owner);
  expect(next).toMatchObject({
    workspaceGrantId: first.workspaceGrantId,
    localSessionId: first.localSessionId,
  });
  expect(
    await readFile(join(await pathFor(next.workspaceGrantId), "proof"), "utf8"),
  ).toBe("first turn");
});

it.each([
  { userId: "participant-b" },
  { projectId: "project-b" },
  { study: { ...owner.study, scenarioId: "study-b" } },
  { study: { ...owner.study, accessVersion: 2 } },
  { study: { ...owner.study, chatSessionId: "chat-b" } },
])("isolates ownership change %j", async (override) => {
  const first = await prepareLocalStudyWorkspace(owner);
  const second = await prepareLocalStudyWorkspace({ ...owner, ...override });
  expect(first.workspaceGrantId).not.toBe(second.workspaceGrantId);
  expect(first.localSessionId).not.toBe(second.localSessionId);
});

it("isolates another installation and another Inspector process", async () => {
  const first = await prepareLocalStudyWorkspace(owner);
  await writeFile(
    join(home, ".mcpjam", "harness-local", "machine.json"),
    JSON.stringify({ machineId: "machine-replacement" }),
  );
  const anotherMachine = await prepareLocalStudyWorkspace(owner);
  expect(anotherMachine.workspaceGrantId).not.toBe(first.workspaceGrantId);
  mocks.probe.mockResolvedValue({ state: "alive", identity: "owner-b" });
  const restarted = await prepareLocalStudyWorkspace(owner);
  expect(restarted.workspaceGrantId).not.toBe(anotherMachine.workspaceGrantId);
});

it("serializes concurrent setup for the same conversation", async () => {
  const results = await Promise.all(
    Array.from({ length: 4 }, () => prepareLocalStudyWorkspace(owner)),
  );
  expect(new Set(results.map((result) => result.workspaceGrantId)).size).toBe(
    1,
  );
});

it("refuses incomplete ownership and an unknown process", async () => {
  await expect(
    prepareLocalStudyWorkspace({ ...owner, userId: "" }),
  ).rejects.toThrow("Invalid local study");
  mocks.probe.mockResolvedValue({
    state: "unknown",
    reason: "probe unavailable",
  });
  await expect(prepareLocalStudyWorkspace(owner)).rejects.toThrow(
    "Cannot establish",
  );
});

it("never takes over a mismatched scratch owner", async () => {
  const workspace = await prepareLocalStudyWorkspace(owner);
  const path = await pathFor(workspace.workspaceGrantId);
  const name = path.split(/[\\/]/).at(-1)!;
  await writeFile(
    join(home, ".mcpjam", "harness-local", "scratch-owners", name),
    "another owner",
  );
  await expect(prepareLocalStudyWorkspace(owner)).rejects.toThrow(
    "another owner",
  );
});

it.skipIf(process.platform === "win32")(
  "refuses a replaced workspace symlink",
  async () => {
    const workspace = await prepareLocalStudyWorkspace(owner);
    const path = await pathFor(workspace.workspaceGrantId);
    const other = join(home, "another-folder");
    await mkdir(other);
    await rm(path, { recursive: true });
    await symlink(other, path);
    await expect(prepareLocalStudyWorkspace(owner)).rejects.toThrow(
      "private folder",
    );
  },
);

it("retains files and grants until stop is confirmed, then removes both", async () => {
  const workspace = await prepareLocalStudyWorkspace(owner);
  const path = await pathFor(workspace.workspaceGrantId);
  const state = join(
    home,
    ".mcpjam",
    "harness-local",
    "sessions",
    workspace.localSessionId,
  );
  await mkdir(state, { recursive: true });
  await writeFile(join(path, "proof"), "keep");
  const binding = {
    ...owner,
    machineId: workspace.machineId,
    workspaceGrantId: workspace.workspaceGrantId,
    harnessId: "claude-code" as const,
    targetKind: "local-native" as const,
    runtimeId: "runtime",
    permissionProfile: "workspace-edits" as const,
    policyVersion: LOCAL_HARNESS_POLICY_VERSION,
  };
  const grant = await grantLocalHarnessConsent(binding);
  mocks.stop.mockResolvedValueOnce(false);
  expect(await workspace.cleanup()).toBe(false);
  expect(await readFile(join(path, "proof"), "utf8")).toBe("keep");
  expect((await verifyLocalHarnessGrant(grant.token, binding)).ok).toBe(true);
  expect(await workspace.cleanup()).toBe(true);
  await expect(readFile(join(path, "proof"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(readFile(state)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await verifyLocalHarnessGrant(grant.token, binding)).ok).toBe(false);
});
