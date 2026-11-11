/**
 * The skills a Copilot CLI session loads: the folder MCPJam's box writer fills
 * for the turn, and nothing else. The SDK's empty mode keeps skills off until
 * the session sets `enableSkills`. Config discovery stays off, so the `.claude`,
 * `.agents` and `.github` skill folders above the working directory don't
 * load, and the CLI's two built-in skills are hidden by name: SDK 1.0.11 has no
 * other way to leave them out.
 *
 * Kept apart from the bridge so its tests can read it. It imports nothing of
 * the server's: the bridge bundle is part of the recipe the computer template
 * bakes, and server code in it would move the recipe's identity whenever that
 * code changed.
 */
import { join } from "node:path";

/** Where the box writer puts the turn's skills, under the box's home: the
 *  write folder of Copilot CLI's skills descriptor. */
export const COPILOT_SKILLS_FOLDER = ".copilot/skills";

/** The CLI's built-in skills, which a turn never gets. */
export const COPILOT_BUILTIN_SKILLS = [
  "customize-cloud-agent",
  "github-pr-media",
] as const;

/**
 * The session's tools and skills. Its tools are the host's custom tools plus
 * the built-in `skill` tool, which loads a skill's SKILL.md. `availableTools`
 * is an allow list and an `excludedTools` pattern always wins over it, so
 * `builtin:skill` can't sit behind a `builtin:*` exclusion: the allow list is
 * what keeps every other built-in tool off.
 */
export function sessionSkillsAndTools(
  home: string,
  customToolNames: readonly string[],
) {
  return {
    availableTools: [
      ...customToolNames.map((name) => `custom:${name}`),
      "builtin:skill",
    ],
    excludedTools: ["mcp:*"],
    enableConfigDiscovery: false,
    enableSkills: true,
    skillDirectories: [join(home, COPILOT_SKILLS_FOLDER)],
    disabledSkills: [...COPILOT_BUILTIN_SKILLS],
  };
}
