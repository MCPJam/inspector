import matter from "gray-matter";
import type {
  Skill,
  SkillListItem,
  SkillFrontmatter,
} from "../../shared/skill-types";

/**
 * Validates skill name format: lowercase letters, numbers, hyphens only
 */
export function isValidSkillName(name: string): boolean {
  return /^[a-z0-9-]+$/.test(name);
}

/**
 * Parses a SKILL.md file content and extracts frontmatter and body
 */
export function parseSkillFile(
  fileContent: string,
  skillPath: string,
): Skill | null {
  try {
    const parsed = matter(fileContent);

    const frontmatter = parsed.data as Partial<SkillFrontmatter>;

    // Validate required fields
    if (!frontmatter.name || typeof frontmatter.name !== "string") {
      console.warn(`Skill at ${skillPath} missing required 'name' field`);
      return null;
    }

    if (
      !frontmatter.description ||
      typeof frontmatter.description !== "string"
    ) {
      console.warn(`Skill at ${skillPath} missing required 'description' field`);
      return null;
    }

    // Validate name format
    if (!isValidSkillName(frontmatter.name)) {
      console.warn(
        `Skill at ${skillPath} has invalid name format: ${frontmatter.name}`,
      );
      return null;
    }

    return {
      name: frontmatter.name,
      description: frontmatter.description,
      content: parsed.content.trim(),
      path: skillPath,
    };
  } catch (error) {
    console.error(`Error parsing skill file at ${skillPath}:`, error);
    return null;
  }
}

/**
 * Converts a Skill to a SkillListItem (without content)
 */
export function skillToListItem(skill: Skill): SkillListItem {
  return {
    name: skill.name,
    description: skill.description,
    path: skill.path,
  };
}

/**
 * Generates SKILL.md content from skill data
 */
export function generateSkillFileContent(
  name: string,
  description: string,
  content: string,
): string {
  const frontmatter = `---
name: ${name}
description: ${description}
---`;

  return `${frontmatter}\n\n${content}`;
}
