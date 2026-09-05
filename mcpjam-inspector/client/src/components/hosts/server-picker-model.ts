/**
 * Decisions behind the two-tab server picker, kept out of the component so
 * they are testable without a popover and a Convex mock.
 *
 * Storage has no column for a bare server: every selection is a
 * `serverAttachments` row, and picking one server resolves to the row holding
 * exactly it. `isServerStandIn` is the one definition of that shape.
 */
/** A `serverAttachments` row, narrowed to what these rules read. */
export type PickerGroup = {
  _id: string;
  name: string;
  serverIds: string[];
  /**
   * Names for `serverIds`, in the same order. OPTIONAL because rows persisted
   * before the field existed arrive without it — the same reason four other
   * readers in the repo guard it. Marked so the compiler enforces that here.
   */
  resolvedServerNames?: string[];
};

/**
 * What the current `serverAttachmentId` means to the UI. `dangling` is not
 * `null`: a deleted row is a different thing from a choice never made.
 */
export type PickerSelection =
  | { kind: "server"; groupId: string; serverId: string; label: string }
  | { kind: "group"; groupId: string; label: string; serverCount: number }
  | { kind: "dangling"; groupId: string };

export type PickerTab = "servers" | "groups";

/** Trimmed and lowercased — the comparison `deriveServerGroupName` also uses. */
function normalize(name: string): string {
  return name.trim().toLowerCase();
}

/** Escape a name for use inside a RegExp — server names are user text. */
function escapeForPattern(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Is this row a bare server's stand-in rather than a group of its own?
 *
 * Both halves are required: a one-server group the user NAMED is a deliberate
 * group, and size alone would swallow it.
 *
 * The name matches either the server's own, or the ` 2`, ` 3`, … form
 * `deriveServerGroupName` falls back to when that one is taken. Recognising
 * only the first meant a mint that had to be suffixed was never seen again, so
 * the next pick of the same server minted another, unbounded. A group a person
 * happens to name `alpha 2` around exactly `alpha` is read as a stand-in — the
 * same collision the unsuffixed rule already accepts.
 */
export function isServerStandIn(group: PickerGroup): boolean {
  if (group.serverIds.length !== 1) return false;
  const serverName = group.resolvedServerNames?.[0];
  // No name to compare against: cannot be judged, so not a stand-in.
  if (!serverName) return false;
  const base = normalize(serverName);
  const name = normalize(group.name);
  if (name === base) return true;
  // From 2 up, because that is where `deriveServerGroupName` starts counting:
  // `alpha 0` and `alpha 1` are names a person chose, and claiming them would
  // hide their group and hand it out as the bare server.
  return new RegExp(`^${escapeForPattern(base)} (?:[2-9]|[1-9][0-9]+)$`).test(
    name,
  );
}

/**
 * The rows the Groups tab offers: everything a server can already be reached
 * by on the Servers tab is dropped, so no choice appears twice.
 */
export function listGroupsForTab(
  groups: readonly PickerGroup[],
): PickerGroup[] {
  return groups.filter((group) => !isServerStandIn(group));
}

/**
 * The stand-in for exactly this one server, if one exists yet.
 *
 * Exact, never "contains": reusing a multi-server row would silently attach
 * servers the user did not choose.
 */
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

  // The SERVER's name, not the row's: a stand-in minted as `alpha 2` still
  // stands in for `alpha`, and that is what the trigger has to say.
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

/**
 * Which tab the popover opens on: the one holding the current selection.
 *
 * Servers is the default, and also where a dangling selection goes — it is the
 * tab the user can fix it from.
 */
export function initialPickerTab(
  selection: PickerSelection | null,
): PickerTab {
  return selection?.kind === "group" ? "groups" : "servers";
}

/** Runtime connection state, keyed by server name. */
export type RuntimeServerMap = Record<string, { connectionStatus: string }>;

/**
 * What the Servers tab knows about one catalog server. Takes a NAME because
 * that is the only key the Convex catalog and the runtime state share.
 *
 * `status: null` is UNKNOWN, not "disconnected" — a surface can mount the
 * picker outside the server-actions provider. `canConnect` is withheld only
 * while a handshake is in flight, so a second click cannot start a second one.
 */
export function resolveServerConnection(
  serverName: string,
  runtime: RuntimeServerMap | null,
): { status: string | null; canConnect: boolean } {
  if (runtime === null) return { status: null, canConnect: false };

  const status = runtime[serverName]?.connectionStatus ?? "disconnected";
  const inFlight =
    status === "connected" || status === "connecting" || status === "oauth-flow";
  return { status, canConnect: !inFlight };
}
