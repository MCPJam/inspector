import { revokeLocalHarnessGrants } from "./grants.js";
import { stopLocalHarnessWorkspace, stopLocalHarnessProject } from "./session-registry.js";
/** Durable user intent, independent of per-run credentials and runtime updates. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { localHarnessStateRoot } from "./grants.js";
import { LOCAL_HARNESS_POLICY_VERSION } from "./targets.js";
import { createLocalStateMutationLock } from "./local-state-lock.js";
import { persistCapabilityState } from "../../local-capability.js";

/**
 * One durable authorization per (user, machine, project, HARNESS) — D5.
 *
 * `harnessId` is OPTIONAL and defaults to `claude-code`: the schema is strict,
 * and every authorization written before Codex existed is a Claude Code one
 * with no such field. Adding Codex is its own consent, never inherited from a
 * Claude Code record.
 */
const authorization = z.object({
  userId: z.string().min(1), machineId: z.string().min(1), projectId: z.string().min(1),
  harnessId: z.enum(["claude-code", "codex"]).default("claude-code"),
  workspaceGrantId: z.string().min(1), policyVersion: z.string().min(1),
  authorizedAt: z.string().datetime(), unattended: z.literal(true),
});
type AuthorizedHarnessId = z.infer<typeof authorization>["harnessId"];
const schema = z.object({ version: z.literal(1), authorizations: z.array(authorization) });
export type LocalHarnessAuthorization = z.infer<typeof authorization>;
const file = () => join(localHarnessStateRoot(), "authorizations.json");
const lock = createLocalStateMutationLock({ rootDir: localHarnessStateRoot, lockFileName: "authorizations.lock", resourceLabel: "authorization" });
async function read() {
  try { return schema.parse(JSON.parse(await readFile(file(), "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1 as const, authorizations: [] as LocalHarnessAuthorization[] };
    throw new Error("Local authorization could not be read. Restore the authorization store or authorize this client again.", { cause: error });
  }
}
export async function readLocalHarnessAuthorization(userId: string, machineId: string, projectId: string, harnessId: AuthorizedHarnessId = "claude-code") {
  return (await read()).authorizations.find(a => a.userId === userId && a.machineId === machineId && a.projectId === projectId && a.harnessId === harnessId && a.policyVersion === LOCAL_HARNESS_POLICY_VERSION) ?? null;
}
export async function authorizeLocalHarness(args: Pick<LocalHarnessAuthorization, "userId" | "machineId" | "projectId" | "workspaceGrantId"> & { harnessId?: AuthorizedHarnessId }) {
  return lock(async () => {
    const state = await read();
    const harnessId = args.harnessId ?? "claude-code";
    const record: LocalHarnessAuthorization = { ...args, harnessId, policyVersion: LOCAL_HARNESS_POLICY_VERSION, authorizedAt: new Date().toISOString(), unattended: true };
    state.authorizations = state.authorizations.filter(a => !(a.userId === args.userId && a.machineId === args.machineId && a.projectId === args.projectId && a.harnessId === harnessId));
    state.authorizations.push(record);
    await persistCapabilityState(file(), state);
    return record;
  });
}
export async function revokeLocalHarnessAuthorization(userId: string, projectId?: string) {
  await lock(async () => {
    const state = await read();
    const revoked = state.authorizations.filter(a => a.userId === userId && (projectId === undefined || a.projectId === projectId));
    state.authorizations = state.authorizations.filter(a => !revoked.includes(a));
    await persistCapabilityState(file(), state);
    await revokeLocalHarnessGrants({ userId, projectId });
    await stopLocalHarnessProject(userId, projectId);
    await Promise.all(revoked.map(a => stopLocalHarnessWorkspace(a.workspaceGrantId)));
  });
}

/** Change only the folder of an existing authorization; never restore a revoked one. */
export async function updateAuthorizedWorkspace(args: Pick<LocalHarnessAuthorization, "userId" | "machineId" | "projectId" | "workspaceGrantId"> & { harnessId?: AuthorizedHarnessId }) {
  await lock(async () => {
    const state = await read();
    const harnessId = args.harnessId ?? "claude-code";
    const record = state.authorizations.find(a => a.userId === args.userId && a.machineId === args.machineId && a.projectId === args.projectId && a.harnessId === harnessId && a.policyVersion === LOCAL_HARNESS_POLICY_VERSION);
    if (!record) return;
    record.workspaceGrantId = args.workspaceGrantId;
    await persistCapabilityState(file(), state);
  });
}
