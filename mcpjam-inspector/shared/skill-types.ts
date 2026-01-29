// Skill types - shared between client and server

/**
 * Skill name validation constants
 */
export const SKILL_NAME_MIN_LENGTH = 1;
export const SKILL_NAME_MAX_LENGTH = 64;

/**
 * Validates skill name format per Agent Skills spec:
 * - Lowercase letters, numbers, hyphens only
 * - Must not start or end with hyphen
 * - Must not contain consecutive hyphens
 * - 1-64 characters
 */
export function isValidSkillName(name: string): boolean {
  if (
    name.length < SKILL_NAME_MIN_LENGTH ||
    name.length > SKILL_NAME_MAX_LENGTH
  )
    return false;
  if (name.includes("--")) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$|^[a-z0-9]$/.test(name);
}

/**
 * Frontmatter structure from SKILL.md files
 */
export interface SkillFrontmatter {
  name: string; // Required: lowercase letters, numbers, hyphens
  description: string; // Required
}

/**
 * Full skill with content (used when loading a skill)
 */
export interface Skill {
  name: string;
  description: string;
  content: string; // Markdown body (without frontmatter)
  path: string; // Directory name
}

/**
 * Skill list item (used for listing skills without full content)
 */
export interface SkillListItem {
  name: string;
  description: string;
  path: string;
}

/**
 * Skill result after selection (includes resolved content)
 */
export interface SkillResult {
  name: string;
  description: string;
  content: string;
  path: string;
}

/**
 * File entry in a skill directory
 */
export interface SkillFile {
  path: string; // Relative path (e.g., "scripts/fill.py")
  name: string; // File name only
  type: "file" | "directory";
  size?: number;
  mimeType?: string;
  extension?: string;
  children?: SkillFile[]; // For directories
}

/**
 * Content of a bundled skill file
 */
export interface SkillFileContent {
  path: string;
  name: string;
  content?: string; // Text content
  base64?: string; // Binary content (images)
  mimeType: string;
  size: number;
  isText: boolean;
}
