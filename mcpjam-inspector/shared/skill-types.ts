// Skill types - shared between client and server

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
