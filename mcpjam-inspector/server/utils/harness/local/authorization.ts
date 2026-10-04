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
 * TWO LISTS IN ONE FILE, because every Inspector version on the machine shares
 * it. Builds from before Codex parse `authorizations` with a schema that has no
 * `harnessId`, and match on user, machine and project alone. So that list
 * holds ONLY Claude Code records, written without `harnessId`: an older build
 * must never read a Codex consent as a Claude Code one. Every other harness
 * lives in `harnessAuthorizations`, a key the old schema drops. An older build
 * that rewrites the file therefore loses those records, which fails closed:
 * the user authorizes Codex again.
 */
const harnessIdSchema = z.enum(["claude-code", "codex"]);
const authorization = z.object({
  userId: z.string().min(1), machineId: z.string().min(1), projectId: z.string().min(1),
  harnessId: harnessIdSchema,
  workspaceGrantId: z.string().min(1), policyVersion: z.string().min(1),
  authorizedAt: z.string().datetime(), unattended: z.literal(true),
});
type AuthorizedHarnessId = z.infer<typeof harnessIdSchema>;
// `harnessId` is tolerated in the legacy list only so a store written by an
// earlier build of this change still reads; it is normalized out on write.
const legacyAuthorization = authorization.extend({ harnessId: harnessIdSchema.optional() });
const schema = z.object({
  version: z.literal(1),
  authorizations: z.array(legacyAuthorization),
  harnessAuthorizations: z.array(authorization).optional(),
});
export type LocalHarnessAuthorization = z.infer<typeof authorization>;
const file = () => join(localHarnessStateRoot(), "authorizations.json");
const lock = createLocalStateMutationLock({ rootDir: localHarnessStateRoot, lockFileName: "authorizations.lock", resourceLabel: "authorization" });
async function read(): Promise<{ authorizations: LocalHarnessAuthorization[] }> {
  try {
    const stored = schema.parse(JSON.parse(await readFile(file(), "utf8")));
    return {
      authorizations: [
        ...stored.authorizations.map((a) => ({ ...a, harnessId: a.harnessId ?? ("claude-code" as const) })),
        ...(stored.harnessAuthorizations ?? []),
      ],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { authorizations: [] };
    throw new Error("Local authorization could not be read. Restore the authorization store or authorize this client again.", { cause: error });
  }
}
async function write(state: { authorizations: LocalHarnessAuthorization[] }) {
  await persistCapabilityState(file(), {
    version: 1,
    authorizations: state.authorizations
      .filter((a) => a.harnessId === "claude-code")
      .map(({ harnessId: _harnessId, ...legacy }) => legacy),
    harnessAuthorizations: state.authorizations.filter((a) => a.harnessId !== "claude-code"),
  });
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
    await write(state);
    return record;
  });
}
export async function revokeLocalHarnessAuthorization(userId: string, projectId?: string) {
  await lock(async () => {
    const state = await read();
    const revoked = state.authorizations.filter(a => a.userId === userId && (projectId === undefined || a.projectId === projectId));
    state.authorizations = state.authorizations.filter(a => !revoked.includes(a));
    await write(state);
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
    await write(state);
  });
}
