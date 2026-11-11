/**
 * The Evaluate page's Skills field, over a suite's environments: what they
 * select together, how one picker click lands on each of them, and the hint
 * lines that say which clients load the result.
 *
 * Environments own their skills. A suite whose environments differ stays that
 * way except for the skill a person clicks, which is then set the same way on
 * every client.
 */
import type { SkillSelectionEdit } from "@/components/project-environments/ProjectEnvironmentSkillsPicker";
import type {
  ProjectEnvironmentSkillSelection,
  ProjectEnvironmentView,
} from "@/hooks/useProjectEnvironments";
import type {
  PaneSkillRow,
  PaneSkillsPreview,
} from "@/shared/pane-skills-preview";

/** Each environment's next skill selection; `undefined` leaves it as it is. */
export type SuiteSkillsEdit = (
  environment: ProjectEnvironmentView,
) => ProjectEnvironmentSkillSelection | null | undefined;

/**
 * Why the field is read only: the backend cannot derive from the stored
 * environment, and copying the browser's view of one would drop its pins.
 */
export const SKILLS_READ_ONLY_REASON =
  "This deployment can’t save skill changes from this page. Edit each environment’s skills on the Environments page.";

export type SuiteSkillState = {
  /** Skills every environment selects, at the same version. */
  value: ProjectEnvironmentSkillSelection | null;
  /** Skills only some environments select, or select at different versions. */
  partialIds: ReadonlySet<string>;
};

/** Each selected skill's pinned version id, or `null` for Latest. */
function versionsBySkill(
  selection: ProjectEnvironmentSkillSelection | null | undefined,
): Map<string, string | null> {
  const pins = new Map(
    (selection?.versionPins ?? []).map((pin) => [pin.skillId, pin.versionId]),
  );
  return new Map(
    (selection?.skillIds ?? []).map((skillId) => [
      skillId,
      pins.get(skillId) ?? null,
    ]),
  );
}

export function suiteSkillState(
  environments: readonly Pick<ProjectEnvironmentView, "skillSelection">[],
): SuiteSkillState {
  const each = environments.map((row) => versionsBySkill(row.skillSelection));
  const ids = [...new Set(each.flatMap((versions) => [...versions.keys()]))];
  const shared = ids.filter((skillId) =>
    each.every(
      (versions) =>
        versions.has(skillId) &&
        versions.get(skillId) === each[0]!.get(skillId),
    ),
  );
  const partialIds = new Set(ids.filter((id) => !shared.includes(id)));
  if (!shared.length) return { value: null, partialIds };
  const versionPins = shared.flatMap((skillId) => {
    const versionId = each[0]!.get(skillId);
    return versionId ? [{ skillId, versionId }] : [];
  });
  return {
    value: {
      mode: "explicit",
      skillIds: shared,
      ...(versionPins.length ? { versionPins } : {}),
    },
    partialIds,
  };
}

/**
 * One environment's selection after a picker click, or `undefined` when the
 * click changes nothing there. Its other skills, their order and their pins
 * stay. An added skill runs Latest, as a newly checked row does, so a click
 * on a partly-on skill leaves it at one version on every client.
 */
export function editedSkillSelection(
  selection: ProjectEnvironmentSkillSelection | null | undefined,
  edit: SkillSelectionEdit,
): ProjectEnvironmentSkillSelection | null | undefined {
  const skillIds = selection?.skillIds ?? [];
  const pins = selection?.versionPins ?? [];
  const selected = skillIds.includes(edit.skillId);
  const pinned =
    pins.find((pin) => pin.skillId === edit.skillId)?.versionId ?? null;
  const unpinned = pins.filter((pin) => pin.skillId !== edit.skillId);
  let nextIds = skillIds;
  let nextPins = unpinned;
  if (edit.kind === "pin") {
    const { skillId, versionId } = edit;
    if (!selected || pinned === versionId) return undefined;
    nextPins =
      versionId === null
        ? unpinned
        : pinned === null
          ? [...pins, { skillId, versionId }]
          : pins.map((pin) =>
              pin.skillId === skillId ? { skillId, versionId } : pin,
            );
  } else if (edit.kind === "remove") {
    if (!selected) return undefined;
    nextIds = skillIds.filter((id) => id !== edit.skillId);
  } else {
    if (selected && pinned === null) return undefined;
    if (!selected) nextIds = [...skillIds, edit.skillId];
  }
  // `null` clears: the backend refuses an empty selection.
  if (!nextIds.length) return null;
  return {
    mode: "explicit",
    skillIds: nextIds,
    ...(nextPins.length ? { versionPins: nextPins } : {}),
  };
}

type LeftOutReason = Exclude<
  NonNullable<PaneSkillRow["reason"]>,
  "server-skill-unsupported"
>;

const one = (count: number, singular: string, plural: string) =>
  count === 1 ? singular : plural;

/** "a", "a and b", "a, b and c". */
function listText(items: readonly string[]): string {
  return items.length < 2
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

const leftOutLine: Record<
  LeftOutReason,
  (clients: string[], skills: string[]) => string
> = {
  "unsupported-harness": (clients) =>
    `${listText(clients)} ${one(clients.length, "doesn’t", "don’t")} support skills, so ${one(clients.length, "its", "their")} runs get none.`,
  "invalid-skill-name": (clients, skills) =>
    `${listText(clients)} can’t use the ${one(skills.length, "name", "names")} ${listText(skills)}, so ${one(clients.length, "its", "their")} runs leave ${one(skills.length, "it", "them")} out.`,
  "name-collision": (clients, skills) =>
    `${listText(clients)} ${one(clients.length, "loads", "load")} ${one(skills.length, "another skill", "other skills")} named ${listText(skills)}, so ${one(clients.length, "its", "their")} runs leave ${one(skills.length, "this one", "these")} out.`,
  "plugin-disabled": (clients, skills) =>
    `${listText(clients)} ${one(clients.length, "has", "have")} the plugin for ${listText(skills)} turned off, so ${one(clients.length, "its", "their")} runs leave ${one(skills.length, "it", "them")} out.`,
};

/** What a client loads: a count when it loads every skill, else the names. */
function loadedText(loaded: readonly string[], complete: boolean): string {
  if (!complete || loaded.length === 1) return listText(loaded);
  return loaded.length === 2 ? "both skills" : `all ${loaded.length} skills`;
}

/**
 * The hint lines under the client table, from one skills preview per
 * environment: which clients load the suite's skills, and why a client
 * leaves one out.
 *
 * Skills from MCP servers stay out of these lines. The preview calls them
 * unusable on a runtime, while an eval run hands them to Claude Code and
 * Codex as files, so a line about them would contradict the run.
 */
export function skillDeliveryLines(
  clients: readonly { client: string; preview: PaneSkillsPreview }[],
): string[] {
  const rows = clients.map(({ client, preview }) => {
    const loaded: string[] = [];
    const leftOut: { name: string; reason: LeftOutReason }[] = [];
    for (const skill of preview.skills) {
      if (skill.channels.includes("mcp-server")) continue;
      if (skill.reason === null) loaded.push(skill.name);
      else if (skill.reason !== "server-skill-unsupported")
        leftOut.push({ name: skill.name, reason: skill.reason });
    }
    return { client, loaded, leftOut };
  });
  if (rows.every((row) => !row.loaded.length && !row.leftOut.length)) return [];
  const sameLoaded = (row: (typeof rows)[number]) =>
    JSON.stringify([...row.loaded].sort()) ===
    JSON.stringify([...rows[0]!.loaded].sort());
  if (
    rows.length > 1 &&
    rows.every((row) => !row.leftOut.length && sameLoaded(row))
  ) {
    return [`Every client loads ${loadedText(rows[0]!.loaded, true)}.`];
  }
  // One line per distinct outcome, naming every client it covers, in the
  // order the clients first appear.
  const groups = new Map<
    string,
    { clients: Set<string>; line: (clients: string[]) => string }
  >();
  const add = (
    key: string,
    client: string,
    line: (clients: string[]) => string,
  ) => {
    const group = groups.get(key) ?? { clients: new Set<string>(), line };
    group.clients.add(client);
    groups.set(key, group);
  };
  for (const row of rows) {
    if (row.loaded.length) {
      const text = loadedText(row.loaded, !row.leftOut.length);
      add(
        `loads:${text}`,
        row.client,
        (names) =>
          `${listText(names)} ${one(names.length, "loads", "load")} ${text}.`,
      );
    } else if (!row.leftOut.length) {
      add(
        "none",
        row.client,
        (names) =>
          `${listText(names)} ${one(names.length, "runs", "run")} without skills.`,
      );
    }
    const byReason = new Map<LeftOutReason, string[]>();
    for (const { name, reason } of row.leftOut)
      byReason.set(reason, [...(byReason.get(reason) ?? []), name]);
    for (const [reason, skills] of byReason) {
      add(
        reason === "unsupported-harness"
          ? reason
          : `${reason}:${JSON.stringify(skills)}`,
        row.client,
        (names) => leftOutLine[reason](names, skills),
      );
    }
  }
  return [...groups.values()].map((group) => group.line([...group.clients]));
}
