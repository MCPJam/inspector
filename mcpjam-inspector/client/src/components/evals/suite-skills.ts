/**
 * The Evaluate page's Skills field, over a suite's environments: what they
 * select together, how one picker click lands on each of them, and the hint
 * lines that say which clients load the result.
 *
 * Environments own their skills. A suite whose environments differ stays that
 * way except for the skill a person clicks, which is then set the same way on
 * every client.
 */
import {
  MAX_ENVIRONMENT_SKILLS,
  type SkillSelectionAcross,
  type SkillSelectionEdit,
} from "@/components/project-environments/ProjectEnvironmentSkillsPicker";
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
  across: SkillSelectionAcross;
};

/** Each selected skill's pinned version id, or `null` for Latest. */
function versionsBySkill(
  selection: ProjectEnvironmentSkillSelection | null | undefined,
): Map<string, string | null> {
  const pins = new Map(
    (selection?.versionPins ?? []).map((pin) => [pin.skillId, pin.versionId]),
  );
  return new Map(
    (selection?.skillIds ?? []).map((id) => [id, pins.get(id) ?? null]),
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
  const across: SkillSelectionAcross = {
    partialIds: new Set(ids.filter((id) => !shared.includes(id))),
    largestCount: Math.max(0, ...each.map((versions) => versions.size)),
    // Only an environment that lacks the skill grows when it is added.
    canAdd: (skillId) =>
      each.every(
        (versions) =>
          versions.has(skillId) || versions.size < MAX_ENVIRONMENT_SKILLS,
      ),
  };
  if (!shared.length) return { value: null, across };
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
    across,
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

/** A hint line for the clients that share one outcome. */
type Line = (clients: string[]) => string;

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

function countText(names: readonly string[]): string {
  if (names.length === 1) return names[0]!;
  return names.length === 2 ? "both skills" : `all ${names.length} skills`;
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
    const loaded: { id: string; name: string }[] = [];
    const leftOut: { id: string; name: string; reason: LeftOutReason }[] = [];
    for (const skill of preview.skills) {
      if (skill.channels.includes("mcp-server")) continue;
      const entry = { id: skill.skillId, name: skill.name };
      if (skill.reason === null) loaded.push(entry);
      else if (skill.reason !== "server-skill-unsupported")
        leftOut.push({ ...entry, reason: skill.reason });
    }
    const loadedKey = JSON.stringify(loaded.map((skill) => skill.id).sort());
    return { client, loaded, leftOut, loadedKey };
  });
  if (rows.every((row) => !row.loaded.length && !row.leftOut.length)) return [];
  // A count ("both skills") is only true when every client that loads
  // skills loads the same ones and leaves none out; otherwise name them.
  const loading = rows.filter((row) => row.loaded.length);
  const counted =
    new Set(loading.map((row) => row.loadedKey)).size === 1 &&
    loading.every((row) => !row.leftOut.length);
  if (rows.length > 1 && counted && loading.length === rows.length) {
    return [
      `Every client loads ${countText(rows[0]!.loaded.map((skill) => skill.name))}.`,
    ];
  }
  const groups = new Map<string, { clients: Set<string>; line: Line }>();
  const add = (key: string, client: string, line: Line) => {
    const group = groups.get(key) ?? { clients: new Set<string>(), line };
    group.clients.add(client);
    groups.set(key, group);
  };
  for (const row of rows) {
    if (row.loaded.length) {
      const names = row.loaded.map((skill) => skill.name);
      const text = counted ? countText(names) : listText(names);
      add(
        `loads:${row.loadedKey}`,
        row.client,
        (clients) =>
          `${listText(clients)} ${one(clients.length, "loads", "load")} ${text}.`,
      );
    } else if (!row.leftOut.length) {
      add(
        "none",
        row.client,
        (clients) =>
          `${listText(clients)} ${one(clients.length, "runs", "run")} without skills.`,
      );
    }
    const byReason = new Map<LeftOutReason, typeof row.leftOut>();
    for (const skill of row.leftOut) {
      const same = byReason.get(skill.reason) ?? [];
      byReason.set(skill.reason, [...same, skill]);
    }
    for (const [reason, skills] of byReason) {
      const names = skills.map((skill) => skill.name);
      add(
        reason === "unsupported-harness"
          ? reason
          : `${reason}:${JSON.stringify(skills.map((skill) => skill.id))}`,
        row.client,
        (clients) => leftOutLine[reason](clients, names),
      );
    }
  }
  return [...groups.values()].map((group) => group.line([...group.clients]));
}
