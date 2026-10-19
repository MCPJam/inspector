/**
 * Which server group and servers a launch ran against, for the run header.
 *
 * Reads only what each run froze at launch: `environment.servers` (names) and
 * `environmentServerAttachmentId` (the group). The group NAME is looked up
 * live, which is safe because a group cannot be renamed. Servers a pinned
 * plugin contributed are not in `environment.servers` and are not shown.
 */
import type { EvalSuiteRun } from "../evals/types";

export type RunServerGroup =
  | { id: string; name: string }
  | { id: string; deleted: true }
  | { id: string; pending: true };

export interface RunServerScopeEntry {
  /** `null`: the run recorded no group, or groups are hidden. */
  group: RunServerGroup | null;
  servers: string[];
  /** Clients that used this group; filled only when the launch used several. */
  clients: string[];
}

type ScopeRun = Pick<EvalSuiteRun, "configSnapshot">;

export function runServerScope<T extends ScopeRun>(
  targets: readonly T[],
  /** `undefined` while the group list loads: no group may read as deleted. */
  groupNamesById: ReadonlyMap<string, string> | undefined,
  options: { showGroups: boolean; clientLabel: (run: T) => string | null },
): RunServerScopeEntry[] {
  const byGroup = new Map<
    string | null,
    { servers: string[]; clients: string[] }
  >();
  for (const run of targets) {
    const groupId = options.showGroups
      ? run.configSnapshot?.environmentServerAttachmentId ?? null
      : null;
    const entry = byGroup.get(groupId) ?? { servers: [], clients: [] };
    byGroup.set(groupId, entry);
    for (const server of run.configSnapshot?.environment?.servers ?? []) {
      if (!entry.servers.includes(server)) entry.servers.push(server);
    }
    const client = options.clientLabel(run);
    if (client && !entry.clients.includes(client)) entry.clients.push(client);
  }

  const mixed = byGroup.size > 1;
  return [...byGroup].map(([id, { servers, clients }]) => ({
    group: id === null ? null : resolveGroup(id, groupNamesById),
    servers,
    clients: mixed ? clients : [],
  }));
}

function resolveGroup(
  id: string,
  groupNamesById: ReadonlyMap<string, string> | undefined,
): RunServerGroup {
  if (!groupNamesById) return { id, pending: true };
  const name = groupNamesById.get(id);
  // The list omits soft-deleted groups, and only a deleted group can vanish.
  return name === undefined ? { id, deleted: true } : { id, name };
}
