import type {
  Skill,
  SkillListItem,
  SkillFile,
  SkillFileContent,
} from "../../../../../../shared/skill-types";
import type { SkillsSource } from "@/lib/apis/mcp-skills-api";

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
  /**
   * The source this skill was selected from, captured at selection time. Later
   * file reads (expanding the card) use THIS, not whatever project is active
   * now — so switching projects can't make a card fetch the wrong project's
   * files. Absent for legacy/local selections (card falls back to the current
   * source prop).
   */
  source?: SkillsSource;
}

// Re-export for convenience
export type { Skill, SkillListItem, SkillFile, SkillFileContent };
