import type { ScenarioMode } from "@/hooks/useScenarios";

/** UI preset for scenario access (maps to `mode` + `allowGuestAccess`). */
export type ScenarioAccessPreset =
  | "project"
  | "invited_only"
  | "link_guests";

export function scenarioAccessPresetFromSettings(
  mode: ScenarioMode,
  allowGuestAccess: boolean,
): ScenarioAccessPreset {
  if (mode === "invited_only") {
    return "invited_only";
  }
  if (mode === "project_members") {
    return "project";
  }
  return allowGuestAccess ? "link_guests" : "project";
}

/**
 * The access choice as a create flow offers it, ordered least- to
 * most-exposed. Shared by both scenario create flows so the wording a user
 * reads doesn't depend on which one they happened to open.
 */
export const SCENARIO_ACCESS_OPTIONS: ReadonlyArray<{
  value: ScenarioAccessPreset;
  label: string;
  description: string;
}> = [
  {
    value: "invited_only",
    label: "Invited users only",
    description: "Only people you invite by email can open this scenario.",
  },
  {
    value: "link_guests",
    label: "Anyone with the link",
    description:
      "Anyone with the link can open it, including guests without an account. Guest usage runs on your organization's credits.",
  },
  {
    value: "project",
    label: "Project members",
    description:
      "Signed-in members of this project can open it with the link. Guests cannot.",
  },
];

export function settingsFromScenarioAccessPreset(
  preset: ScenarioAccessPreset,
): { mode: ScenarioMode; allowGuestAccess: boolean } {
  switch (preset) {
    case "project":
      return { mode: "project_members", allowGuestAccess: false };
    case "link_guests":
      return { mode: "anyone_with_link", allowGuestAccess: true };
    case "invited_only":
      return { mode: "invited_only", allowGuestAccess: false };
  }
}
