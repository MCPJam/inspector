/** Scratch ownership stays in the control store, outside the writable workspace. */
import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { localHarnessStateRoot, forgetWorkspaceGrant, pruneExpiredHarnessGrants } from "./grants.js";
import { probeProcess } from "./process-identity.js";
import { listProcessRecords } from "./process-registry.js";
import { logger } from "../../logger.js";

export const scratchRoot = () => join(homedir(), ".mcpjam", "harness-workspaces", "scratch");
const ownersRoot = () => join(localHarnessStateRoot(), "scratch-owners");
const validName = (name: string) => /^run-[a-zA-Z0-9]+$/.test(name);

export async function recordScratchOwner(name: string, workspaceGrantId: string) {
  if (!validName(name)) throw new Error("Invalid scratch directory name");
  const owner = await probeProcess(process.pid);
  if (owner.state !== "alive") throw new Error("Cannot establish scratch workspace ownership");
  await mkdir(ownersRoot(), { recursive: true, mode: 0o700 });
  await writeFile(join(ownersRoot(), name), JSON.stringify({ pid: process.pid, birth: owner.identity, workspaceGrantId }), { mode: 0o600, flag: "wx" });
}
export async function forgetScratchOwner(name: string) {
  if (validName(name)) await rm(join(ownersRoot(), name), { force: true });
}

export async function sweepLocalHarnessScratch() {
  await pruneExpiredHarnessGrants();
  let names: string[];
  try { names = await readdir(ownersRoot()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for (const name of names) {
    if (!validName(name)) continue;
    try {
      const owner = JSON.parse(await readFile(join(ownersRoot(), name), "utf8"));
      if (!Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.birth !== "string" || typeof owner.workspaceGrantId !== "string") continue;
      const probe = await probeProcess(owner.pid);
      if (probe.state === "unknown" || (probe.state === "alive" && probe.identity === owner.birth)) continue;
      // Reclamation must have proved the entire child tree gone first. Unknown
      // or live records stay in the registry and protect their workspace.
      if ((await listProcessRecords()).some(record => record.workspaceGrantId === owner.workspaceGrantId)) continue;
      await rm(join(scratchRoot(), name), { recursive: true, force: true });
      await forgetWorkspaceGrant(owner.workspaceGrantId);
      await forgetScratchOwner(name);
    } catch (error) { logger.warn("[local-harness] Could not reclaim scratch workspace", { name, error: String(error) }); }
  }
}

let startup: Promise<void> | undefined;
export function startLocalHarnessJanitor() {
  startup ??= (async () => {
    const { localHarnessSupervisor } = await import("./local-turn.js");
    await localHarnessSupervisor().reclaimOrphans();
    await sweepLocalHarnessScratch();
  })().catch(error => { logger.warn("[local-harness] Startup cleanup failed", { error: String(error) }); });
  return startup;
}
