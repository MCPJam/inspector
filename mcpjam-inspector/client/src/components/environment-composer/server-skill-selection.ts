import type { ProjectEnvironmentServerSkillSelection } from "@/hooks/useProjectEnvironments";

/**
 * Two MCP-server skill selections are the same when their picks and pins match
 * in order, as the backend fingerprints them.
 */
export function sameServerSkillSelection(
  a: ProjectEnvironmentServerSkillSelection | null | undefined,
  b: ProjectEnvironmentServerSkillSelection | null | undefined,
): boolean {
  const key = (selection: typeof a) =>
    JSON.stringify(
      selection
        ? [
            selection.serverSkillIds,
            (selection.versionPins ?? []).map((pin) => [
              pin.serverSkillId,
              pin.versionId,
            ]),
          ]
        : null,
    );
  return key(a) === key(b);
}
