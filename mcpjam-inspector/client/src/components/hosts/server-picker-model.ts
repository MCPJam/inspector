/**
 * The picker's rules, out of the component so they test without a popover.
 *
 * Storage has no column for a bare server: every selection is a
 * `serverAttachments` row, and picking one server resolves to the row holding
 * exactly it. `isServerStandIn` is the one definition of that shape.
 */
export type PickerGroup = {
  _id: string;
  name: string;
  serverIds: string[];
  /** Optional: rows written before the field existed arrive without it. */
  resolvedServerNames?: string[];
};

/** `dangling` is not `null`: a deleted row differs from a choice never made. */
export type PickerSelection =
  | { kind: "server"; groupId: string; serverId: string; label: string }
  | { kind: "group"; groupId: string; label: string; serverCount: number }
  | { kind: "dangling"; groupId: string };

export type PickerTab = "servers" | "groups";

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Is this row a bare server's stand-in rather than a group of its own?
 *
 * The suffixed form counts too: missing it meant a mint that collided was
 * never recognised again, so every pick of that server minted another.
 */
export function isServerStandIn(group: PickerGroup): boolean {
  if (group.serverIds.length !== 1) return false;
  const serverName = group.resolvedServerNames?.[0];
  if (!serverName) return false;
  const base = normalize(serverName);
  const name = normalize(group.name);
  if (name === base) return true;
  // Text, not a pattern: names are user input, and `a.b` would claim `axb 2`.
  if (!name.startsWith(`${base} `)) return false;
  // `deriveServerGroupName` counts 2, 3, … — `alpha 1` is a name someone chose.
  const suffix = name.slice(base.length + 1);
  return /^[1-9][0-9]*$/.test(suffix) && Number(suffix) >= 2;
}

/** Groups tab rows: stand-ins are dropped, so no choice appears on both tabs. */
export function listGroupsForTab(
  groups: readonly PickerGroup[],
): PickerGroup[] {
  return groups.filter((group) => !isServerStandIn(group));
}

/** Exact, never "contains": a wider row would attach servers nobody picked. */
export function findSoloGroup(
  groups: readonly PickerGroup[],
  serverId: string,
): PickerGroup | null {
  return (
    groups.find(
      (group) => isServerStandIn(group) && group.serverIds[0] === serverId,
    ) ?? null
  );
}

/** Read the stored `serverAttachmentId` as something the trigger can render. */
export function resolvePickerSelection(
  groups: readonly PickerGroup[],
  selectedId: string | null,
): PickerSelection | null {
  if (!selectedId) return null;

  const row = groups.find((group) => group._id === selectedId);
  if (!row) return { kind: "dangling", groupId: selectedId };

  // The SERVER's name: a stand-in minted as `alpha 2` still stands in for alpha.
  const standInName = isServerStandIn(row)
    ? row.resolvedServerNames?.[0]
    : undefined;
  if (standInName) {
    return {
      kind: "server",
      groupId: row._id,
      serverId: row.serverIds[0],
      label: standInName,
    };
  }

  return {
    kind: "group",
    groupId: row._id,
    label: row.name,
    serverCount: row.serverIds.length,
  };
}

/** The tab holding the selection. Dangling goes to Servers — it is fixable there. */
export function initialPickerTab(selection: PickerSelection | null): PickerTab {
  return selection?.kind === "group" ? "groups" : "servers";
}

export type RuntimeServerMap = Record<string, { connectionStatus: string }>;

/**
 * Keyed by NAME — the only key the Convex catalog and the runtime state share.
 * `status: null` is UNKNOWN, not disconnected: a surface can mount this picker
 * outside the server-actions provider.
 */
export function resolveServerConnection(
  serverName: string,
  runtime: RuntimeServerMap | null,
): { status: string | null; canConnect: boolean } {
  if (runtime === null) return { status: null, canConnect: false };

  const status = runtime[serverName]?.connectionStatus ?? "disconnected";
  const inFlight =
    status === "connected" ||
    status === "connecting" ||
    status === "oauth-flow";
  return { status, canConnect: !inFlight };
}
