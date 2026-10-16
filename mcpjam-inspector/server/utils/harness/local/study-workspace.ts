import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  getLocalMachineId,
  localHarnessStateRoot,
  registerWorkspaceGrant,
} from "./grants.js";
import { createLocalStateMutationLock } from "./local-state-lock.js";
import { probeProcess } from "./process-identity.js";
import { cleanupLocalHarnessScratch } from "./scratch-cleanup.js";
import { recordScratchOwner, scratchRoot } from "./scratch-janitor.js";
import {
  isLocalStudyGrantBinding,
  type LocalStudyGrantBinding,
} from "./study-grant-binding.js";

const withWorkspaceLock = createLocalStateMutationLock({
  rootDir: localHarnessStateRoot,
  lockFileName: "study-workspace.lock",
  resourceLabel: "study workspace",
});

/** Allocates files only; callers must separately obtain study authorization. */
export async function prepareLocalStudyWorkspace(args: {
  userId: string;
  projectId: string;
  study: LocalStudyGrantBinding;
}) {
  if (
    !args.userId.trim() ||
    !args.projectId.trim() ||
    !isLocalStudyGrantBinding(args.study)
  ) {
    throw new Error("Invalid local study workspace ownership");
  }
  const machineId = await getLocalMachineId();
  const owner = await probeProcess(process.pid);
  if (owner.state !== "alive")
    throw new Error("Cannot establish study workspace ownership");
  // A restarted Inspector gets new scratch state; the existing janitor owns
  // reclaiming its predecessor's files after proving its process tree gone.
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        args.userId,
        machineId,
        args.projectId,
        args.study.scenarioId,
        args.study.accessVersion,
        args.study.chatSessionId,
        process.pid,
        owner.identity,
      ]),
    )
    .digest("hex");
  const name = `run-${key}`;
  const localSessionId = `local-study-${key}`;
  return withWorkspaceLock(async () => {
    await mkdir(join(scratchRoot(), name), { recursive: true, mode: 0o700 });
    if (
      (await realpath(join(scratchRoot(), name))) !==
      join(await realpath(scratchRoot()), name)
    ) {
      throw new Error(
        "Study workspace must not resolve outside its private folder",
      );
    }
    const workspace = await registerWorkspaceGrant(join(scratchRoot(), name));
    if (!workspace.ok) throw new Error(workspace.message);
    const workspaceGrantId = workspace.grant.workspaceGrantId;
    await recordScratchOwner(name, workspaceGrantId);
    return {
      machineId,
      workspaceGrantId,
      localSessionId,
      cleanup: () =>
        withWorkspaceLock(() =>
          cleanupLocalHarnessScratch({
            name,
            workspaceGrantId,
            localSessionId,
          }),
        ),
    };
  });
}
