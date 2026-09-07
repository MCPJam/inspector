import { type UserValueStage } from "@mcpjam/sdk/contract";
import {
  EVAL_SUITE_SETTINGS_MANIFEST,
  type EvalSuiteSettingKey,
} from "@/shared/eval-suite-settings-manifest";
import type { SuiteSettingsGroupId } from "./suite-settings-groups";
import { NESTED_SETTING_KEYS } from "./suite-settings-groups";

/** Rail label for the judge cards. The row itself stays "Judge". */
const JUDGES_RAIL_LABEL = "Judges";

export type SuiteSettingsSubsectionTarget =
  | { type: "row"; key: EvalSuiteSettingKey }
  | { type: "stage"; stage: UserValueStage }
  | { type: "passOrFailChecks" };

export type SuiteSettingsSubsection = {
  id: string;
  label: string;
  target: SuiteSettingsSubsectionTarget;
};

function manifestLabel(key: EvalSuiteSettingKey): string {
  const row = EVAL_SUITE_SETTINGS_MANIFEST.find((entry) => entry.key === key);
  if (!row) throw new Error(`no manifest row for ${key}`);
  return row.label;
}

export function getSubsectionsForGroup(
  groupId: SuiteSettingsGroupId,
  options: {
    isVerdictPolicyV2: boolean;
    showComputerEnvironment: boolean;
    showSchedule: boolean;
    showDelete: boolean;
  },
): readonly SuiteSettingsSubsection[] {
  switch (groupId) {
    case "grading": {
      return [
        {
          id: "policy",
          label: manifestLabel("policy"),
          target: { type: "row", key: "policy" },
        },
        {
          id: "checks",
          label: manifestLabel("checks"),
          target: { type: "passOrFailChecks" },
        },
        {
          id: "judge",
          label: JUDGES_RAIL_LABEL,
          target: { type: "row", key: "judge" },
        },
      ];
    }
    case "runs": {
      const subs: SuiteSettingsSubsection[] = [];
      if (options.showComputerEnvironment) {
        subs.push({
          id: "computerEnvironment",
          label: manifestLabel("computerEnvironment"),
          target: { type: "row", key: "computerEnvironment" },
        });
      }
      subs.push({
        id: "environments",
        label: manifestLabel("environments"),
        target: { type: "row", key: "environments" },
      });
      return subs;
    }
    case "limits":
      return [
        {
          id: "budgets",
          label: manifestLabel("budgets"),
          target: { type: "row", key: "budgets" },
        },
      ];
    case "triggers": {
      const subs: SuiteSettingsSubsection[] = [];
      if (options.showSchedule) {
        subs.push({
          id: "schedule",
          label: manifestLabel("schedule"),
          target: { type: "row", key: "schedule" },
        });
      }
      subs.push({
        id: "githubChecks",
        label: manifestLabel("githubChecks"),
        target: { type: "row", key: "githubChecks" },
      });
      return subs;
    }
    case "danger":
      return options.showDelete
        ? [
            {
              id: "deleteSuite",
              label: manifestLabel("deleteSuite"),
              target: { type: "row", key: "deleteSuite" },
            },
          ]
        : [];
    default:
      return [];
  }
}

export function subsectionForSettingKey(
  key: EvalSuiteSettingKey,
  groupId: SuiteSettingsGroupId,
  options: Parameters<typeof getSubsectionsForGroup>[1],
): SuiteSettingsSubsection | undefined {
  const subsections = getSubsectionsForGroup(groupId, options);
  for (const [rowKey, nested] of Object.entries(NESTED_SETTING_KEYS)) {
    if ((nested as readonly string[]).includes(key)) {
      const parent = subsections.find(
        (sub) => sub.target.type === "row" && sub.target.key === rowKey,
      );
      if (parent) return parent;
    }
  }
  if (
    groupId === "grading" &&
    (key === "passOrFail" || key === "checks" || key === "matchOptions")
  ) {
    return subsections.find((sub) => sub.target.type === "passOrFailChecks");
  }
  if (
    groupId === "grading" &&
    (key === "judge" || key === "judgeRubric" || key === "judgeGroundedness")
  ) {
    return subsections.find((sub) => sub.id === "judge");
  }
  if (groupId === "grading" && key === "validity") {
    return subsections.find((sub) => sub.id === "policy");
  }
  return subsections.find(
    (sub) => sub.target.type === "row" && sub.target.key === key,
  );
}

/** Scroll anchor for the right-rail subsection nav. */
export function subsectionScrollTarget(
  subsection: SuiteSettingsSubsection,
): string {
  if (subsection.target.type === "stage") {
    return `[data-stage-group="${subsection.target.stage}"]`;
  }
  if (subsection.target.type === "passOrFailChecks") {
    return `[data-setting-key="checks"]`;
  }
  return `[data-subsection-id="${subsection.id}"]`;
}

/** Which subsection owns the scroll position — last anchor at/above the line. */
export function pickActiveSubsectionFromScroll(
  root: HTMLElement,
  subsections: readonly SuiteSettingsSubsection[],
): string | undefined {
  const anchors = subsections
    .map((subsection) => ({
      id: subsection.id,
      element: root.querySelector(subsectionScrollTarget(subsection)),
    }))
    .filter(
      (entry): entry is { id: string; element: Element } =>
        entry.element != null,
    );
  if (anchors.length === 0) return undefined;
  const rootTop = root.getBoundingClientRect().top;
  const activationY = root.scrollTop + root.clientHeight * 0.12;
  let activeId = anchors[0].id;
  for (const { id, element } of anchors) {
    const top =
      element.getBoundingClientRect().top - rootTop + root.scrollTop;
    if (top <= activationY + 1) activeId = id;
  }
  return activeId;
}
