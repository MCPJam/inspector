import type { Skill, SkillListItem } from "../../../../../../shared/skill-types";

/**
 * Skill result after selection (with resolved content)
 * Matches the shape used by the parent components
 */
export interface SkillResult extends Skill {
  // Skill already has all needed fields: name, description, content, path
}

// Re-export for convenience
export type { Skill, SkillListItem };
