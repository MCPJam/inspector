import { rm } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../../logger.js";
import { forgetWorkspaceGrant, localHarnessStateRoot } from "./grants.js";
import { forgetScratchOwner, scratchRoot } from "./scratch-janitor.js";
import { stopLocalHarnessWorkspace } from "./session-registry.js";
import { sessionStateDirFor } from "./supervised-provider.js";

/** A live or unconfirmed process always retains its files and authorization. */
export async function cleanupLocalHarnessScratch(args: {
  name: string;
  workspaceGrantId: string;
  localSessionId: string;
}): Promise<boolean> {
  if (!/^run-[a-zA-Z0-9]+$/.test(args.name))
    throw new Error("Invalid scratch directory name");
  try {
    if (!(await stopLocalHarnessWorkspace(args.workspaceGrantId))) {
      logger.warn("[local-harness] Process did not stop; retaining workspace");
      return false;
    }
    const options = {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    };
    await rm(
      sessionStateDirFor(localHarnessStateRoot(), args.localSessionId),
      options,
    );
    await rm(join(scratchRoot(), args.name), options);
    await forgetWorkspaceGrant(args.workspaceGrantId);
    await forgetScratchOwner(args.name);
    return true;
  } catch (error) {
    logger.warn("[local-harness] Workspace cleanup failed", {
      error: String(error),
    });
    return false;
  }
}
