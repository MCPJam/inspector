/**
 * Default name and selection for a new server group, derived from its contents.
 *
 * The picker's rows show only a name and a count, and groups cannot be renamed
 * (there is no update mutation yet), so a name that says what is inside it is
 * worth more here than usual. Pure so the numbering rule — collisions, case,
 * off-by-one — is testable without a popover and a Convex mock.
 */

/** Trimmed and lowercased, for collision checks that ignore padding and case. */
function normalize(name: string): string {
  return name.trim().toLowerCase();
}

/** `group 1`, `group 2`, … — the lowest number not already taken. */
function nextNumberedName(existing: readonly string[]): string {
  const used = new Set<number>();
  for (const name of existing) {
    const match = /^group (\d+)$/i.exec(name.trim());
    if (match) used.add(Number(match[1]));
  }
  let n = 1;
  while (used.has(n)) n += 1;
  return `group ${n}`;
}

/**
 * @param pickedServerNames Servers selected for the new group, in picker order.
 * @param existingGroupNames Names already in use in this project.
 */
export function deriveServerGroupName(
  pickedServerNames: readonly string[],
  existingGroupNames: readonly string[],
): string {
  const picked = pickedServerNames
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  // Nothing to derive from.
  if (picked.length === 0) return nextNumberedName(existingGroupNames);

  const base =
    picked.length === 1 ? picked[0] : `${picked[0]} + ${picked.length - 1}`;

  const taken = new Set(existingGroupNames.map(normalize));
  if (!taken.has(normalize(base))) return base;

  // The unsuffixed name is conceptually the first, so the suffix starts at 2.
  let suffix = 2;
  while (taken.has(normalize(`${base} ${suffix}`))) suffix += 1;
  return `${base} ${suffix}`;
}

/** Above this, "all of them" stops being the obvious answer. */
const PRESELECT_MAX = 3;

/** A server as the picker knows it — id to select by, name to derive from. */
export interface GroupDraftServer {
  _id: string;
  name: string;
}

/** The state a brand-new group form opens in: a small pool arrives already answered. */
export function newGroupDraft(
  pool: readonly GroupDraftServer[],
  existingGroupNames: readonly string[],
): { serverIds: string[]; name: string } {
  const preselected =
    pool.length > 0 && pool.length <= PRESELECT_MAX ? pool : [];
  return {
    serverIds: preselected.map((server) => server._id),
    name: deriveServerGroupName(
      preselected.map((server) => server.name),
      existingGroupNames,
    ),
  };
}
