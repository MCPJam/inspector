import { revokeLocalHarnessGrants } from "./grants.js";
import { DEFAULT_LOCAL_HARNESS_ID } from "../../../../shared/harness-descriptors.js";
import {
  stopLocalHarnessWorkspace,
  stopLocalHarnessProject,
} from "./session-registry.js";
/** Durable user intent, independent of per-run credentials and runtime updates. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { localHarnessStateRoot } from "./grants.js";
import { LOCAL_HARNESS_POLICY_VERSION, type SupportedLocalHarnessId } from "./targets.js";
import { localRuntimeOf } from "./runtimes/index.js";
import { keptField, readByShippedBuilds, SHIPPED_STORE_HARNESS_IDS, splitRuntimeRecords } from "./cross-version-store.js";
import { createLocalStateMutationLock } from "./local-state-lock.js";
import { persistCapabilityState } from "../../local-capability.js";

/**
 * One durable authorization per (user, machine, project, HARNESS).
 *
 * THREE LISTS IN ONE FILE, because every Inspector version on the machine
 * shares it, and each list holds only what the builds reading it can parse:
 *
 *  - `authorizations`: Claude Code alone, written without `harnessId`. Builds
 *    from before a second harness match on user, machine and project only, so
 *    no other harness may ever appear here.
 *  - `harnessAuthorizations`: Codex. Builds that know just these two parse the
 *    list strictly and refuse the whole file over any other id.
 *  - `runtimeAuthorizations`: every other local runtime. Builds that predate
 *    the key drop it, so a rewrite from one of them loses these records and
 *    the member authorizes again, which fails closed. Read entry by entry
 *    (`cross-version-store.ts`).
 */
const harnessIdSchema = z.enum(SHIPPED_STORE_HARNESS_IDS);
const fields = {
  userId: z.string().min(1), machineId: z.string().min(1), projectId: z.string().min(1),
  autoApproveAcknowledgedAt: z.string().datetime().optional(),
  workspaceGrantId: z.string().min(1), policyVersion: z.string().min(1),
  authorizedAt: z.string().datetime(), unattended: z.literal(true),
};
const authorization = z.object({ ...fields, harnessId: harnessIdSchema });
const runtimeAuthorization = z.object({
  ...fields,
  harnessId: z.string().refine((id) => localRuntimeOf(id) !== undefined),
});
// `harnessId` is tolerated in the legacy list only so a store written by an
// earlier build of this change still reads; it is normalized out on write.
const legacyAuthorization = authorization.extend({ harnessId: harnessIdSchema.optional() });
const schema = z.object({
  version: z.literal(1),
  authorizations: z.array(legacyAuthorization),
  harnessAuthorizations: z.array(authorization).optional(),
  runtimeAuthorizations: z.array(z.unknown()).optional(),
});
export type LocalHarnessAuthorization = Omit<z.infer<typeof authorization>, "harnessId"> & {
  harnessId: SupportedLocalHarnessId;
};
interface AuthorizationState {
  authorizations: LocalHarnessAuthorization[];
  /** `runtimeAuthorizations` entries this build cannot read, as written. */
  kept: unknown[];
}
const file = () => join(localHarnessStateRoot(), "authorizations.json");
const lock = createLocalStateMutationLock({ rootDir: localHarnessStateRoot, lockFileName: "authorizations.lock", resourceLabel: "authorization" });
async function read(): Promise<AuthorizationState> {
  try {
    const stored = schema.parse(JSON.parse(await readFile(file(), "utf8")));
    const { records: runtimes, kept } = splitRuntimeRecords(stored.runtimeAuthorizations ?? [], (entry): LocalHarnessAuthorization | undefined => {
      const parsed = runtimeAuthorization.safeParse(entry);
      return parsed.success ? { ...parsed.data, harnessId: parsed.data.harnessId as SupportedLocalHarnessId } : undefined;
    });
    return {
      authorizations: [
        ...stored.authorizations.map((a) => ({ ...a, harnessId: a.harnessId ?? DEFAULT_LOCAL_HARNESS_ID })),
        ...(stored.harnessAuthorizations ?? []),
        ...runtimes,
      ],
      kept,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { authorizations: [], kept: [] };
    throw new Error("Local authorization could not be read. Restore the authorization store or authorize this client again.", { cause: error });
  }
}
async function write(state: AuthorizationState) {
  await persistCapabilityState(file(), {
    version: 1,
    authorizations: state.authorizations
      .filter((a) => a.harnessId === DEFAULT_LOCAL_HARNESS_ID)
      .map(({ harnessId: _harnessId, ...legacy }) => legacy),
    harnessAuthorizations: state.authorizations.filter((a) => a.harnessId !== DEFAULT_LOCAL_HARNESS_ID && readByShippedBuilds(a.harnessId)),
    runtimeAuthorizations: [...state.kept, ...state.authorizations.filter((a) => !readByShippedBuilds(a.harnessId))],
  });
}
export async function readLocalHarnessAuthorization(userId: string, machineId: string, projectId: string, harnessId: SupportedLocalHarnessId = DEFAULT_LOCAL_HARNESS_ID) {
  return (await read()).authorizations.find(a => a.userId === userId && a.machineId === machineId && a.projectId === projectId && a.harnessId === harnessId && a.policyVersion === LOCAL_HARNESS_POLICY_VERSION) ?? null;
}
/**
 * Has anybody durably authorized this harness on this machine (at the current
 * policy version)? What boot asks before fetching a runtime nobody is waiting
 * for: a machine where nobody chose to run a harness downloads nothing for it.
 */
export async function hasLocalHarnessAuthorizationOnMachine(machineId: string, harnessId: SupportedLocalHarnessId = DEFAULT_LOCAL_HARNESS_ID): Promise<boolean> {
  return (await read()).authorizations.some(a => a.machineId === machineId && a.harnessId === harnessId && a.policyVersion === LOCAL_HARNESS_POLICY_VERSION);
}
export async function authorizeLocalHarness(args: Pick<LocalHarnessAuthorization, "userId" | "machineId" | "projectId" | "workspaceGrantId"> & { harnessId?: SupportedLocalHarnessId }) {
  return lock(async () => {
    const state = await read();
    const harnessId = args.harnessId ?? DEFAULT_LOCAL_HARNESS_ID;
    const existing = state.authorizations.find(a => a.userId === args.userId && a.machineId === args.machineId && a.projectId === args.projectId && a.harnessId === harnessId && a.policyVersion === LOCAL_HARNESS_POLICY_VERSION);
    const record: LocalHarnessAuthorization = { ...(existing?.autoApproveAcknowledgedAt ? { autoApproveAcknowledgedAt: existing.autoApproveAcknowledgedAt } : {}), ...args, harnessId, policyVersion: LOCAL_HARNESS_POLICY_VERSION, authorizedAt: new Date().toISOString(), unattended: true };
    state.authorizations = state.authorizations.filter(a => !(a.userId === args.userId && a.machineId === args.machineId && a.projectId === args.projectId && a.harnessId === harnessId));
    state.authorizations.push(record);
    await write(state);
    return record;
  });
}
export async function revokeLocalHarnessAuthorization(
  userId: string,
  projectId?: string,
) {
  await lock(async () => {
    const state = await read();
    const revoked = state.authorizations.filter(a => a.userId === userId && (projectId === undefined || a.projectId === projectId));
    state.authorizations = state.authorizations.filter(a => !revoked.includes(a));
    state.kept = state.kept.filter((record) => keptField(record, ["userId"]) !== userId ||
      (projectId !== undefined && keptField(record, ["projectId"]) !== projectId));
    await write(state);
    await revokeLocalHarnessGrants({ userId, projectId });
    await stopLocalHarnessProject(userId, projectId);
    await Promise.all(
      revoked.map((a) => stopLocalHarnessWorkspace(a.workspaceGrantId)),
    );
  });
}

/** Change only the folder of an existing authorization; never restore a revoked one. */
export async function updateAuthorizedWorkspace(args: Pick<LocalHarnessAuthorization, "userId" | "machineId" | "projectId" | "workspaceGrantId"> & { harnessId?: SupportedLocalHarnessId }) {
  await lock(async () => {
    const state = await read();
    const harnessId = args.harnessId ?? DEFAULT_LOCAL_HARNESS_ID;
    const record = state.authorizations.find(a => a.userId === args.userId && a.machineId === args.machineId && a.projectId === args.projectId && a.harnessId === harnessId && a.policyVersion === LOCAL_HARNESS_POLICY_VERSION);
    if (!record) return;
    record.workspaceGrantId = args.workspaceGrantId;
    await write(state);
  });
}

/** Explicit attended Off consent; cannot create or revive authorization. */
export async function acknowledgeLocalHarnessAutoApprove(args: {
  userId: string;
  machineId: string;
  projectId: string;
  harnessId: SupportedLocalHarnessId;
}) {
  return lock(async () => {
    const state = await read();
    const record = state.authorizations.find(
      (a) =>
        a.userId === args.userId &&
        a.machineId === args.machineId &&
        a.projectId === args.projectId &&
        a.harnessId === args.harnessId &&
        a.policyVersion === LOCAL_HARNESS_POLICY_VERSION,
    );
    if (!record)
      throw new Error(
        "Set up this local harness before allowing commands without asking",
      );
    record.autoApproveAcknowledgedAt ??= new Date().toISOString();
    await write(state);
    return record;
  });
}
