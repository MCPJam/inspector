/**
 * The emulated skill tool names.
 *
 * A mirror of `SKILL_TOOL_NAMES` in the inspector's `shared/eval-matching.ts`,
 * which is where the runner decides what counts as a skill call today. The
 * matcher exempts these from a turn's expectations (a skill LOAD is agent
 * housekeeping, not a task action), so the engine has to agree on the list or
 * a `maxExtraToolCalls: 0` case would fail here for a `loadSkill` the matcher
 * ignores. An inspector test pins the two lists together; `evaluate` also takes
 * an `isSkillTool` override so a caller that owns the list can pass its own.
 */
export const SKILL_TOOL_NAMES = [
  "listSkills",
  "loadSkill",
  "listSkillFiles",
  "readSkillFile",
] as const;

const SKILL_TOOL_NAME_SET: ReadonlySet<string> = new Set(SKILL_TOOL_NAMES);

export function isSkillToolName(name: string): boolean {
  return SKILL_TOOL_NAME_SET.has(name);
}
