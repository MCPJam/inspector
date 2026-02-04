import type {
  Skill,
  SkillListItem,
  SkillFile,
  SkillFileContent,
} from "../../../../../../shared/skill-types";

/**
 * A selected file from a skill directory
 */
export interface SelectedSkillFile {
  path: string;
  name: string;
  content: string;
  mimeType: string;
}

/**
 * Skill result after selection (with resolved content)
 * Matches the shape used by the parent components
 */
export interface SkillResult extends Skill {
  // Skill already has all needed fields: name, description, content, path
  // Additional files selected by the user
  selectedFiles?: SelectedSkillFile[];
}

// Re-export for convenience
export type { Skill, SkillListItem, SkillFile, SkillFileContent };
