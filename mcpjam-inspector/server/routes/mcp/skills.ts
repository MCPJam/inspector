import { Hono } from "hono";
import fs from "fs/promises";
import path from "path";
import os from "os";
import "../../types/hono"; // Type extensions
import { logger } from "../../utils/logger";
import {
  parseSkillFile,
  skillToListItem,
  isValidSkillName,
  generateSkillFileContent,
} from "../../utils/skill-parser";
import type { Skill, SkillListItem } from "../../../shared/skill-types";

const skills = new Hono();

/**
 * Get all skills directories as absolute paths
 *
 * Skills can come from:
 * 1. Global user skills: ~/.mcpjam/skills/ and ~/.agents/skills/
 * 2. Project-local skills: .mcpjam/skills/ and .agents/skills/ (relative to cwd)
 *
 * Order matters - first writable directory is used for uploads
 */
function getSkillsDirs(): string[] {
  const homeDir = os.homedir();
  const cwd = process.cwd();

  return [
    // Global skills (always accessible regardless of how app is launched)
    path.join(homeDir, ".mcpjam", "skills"),   // MCPJam global skills
    path.join(homeDir, ".agents", "skills"),   // npx skills global installs

    // Project-local skills (when launched from project directory)
    path.join(cwd, ".mcpjam", "skills"),
    path.join(cwd, ".agents", "skills"),
  ];
}

/**
 * Get the primary skills directory (for uploads)
 * Uses global ~/.mcpjam/skills/ so skills are always accessible
 */
function getPrimarySkillsDir(): string {
  return path.join(os.homedir(), ".mcpjam", "skills");
}

/**
 * Check if a directory exists
 */
async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * List all skills from all skills directories
 */
skills.post("/list", async (c) => {
  try {
    const skillsDirs = getSkillsDirs();
    const skillsList: SkillListItem[] = [];
    const seenNames = new Set<string>(); // Prevent duplicates by name

    for (const skillsDir of skillsDirs) {
      // Check if this skills directory exists
      if (!(await directoryExists(skillsDir))) {
        continue;
      }

      const entries = await fs.readdir(skillsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillPath = entry.name;
        const skillFilePath = path.join(skillsDir, skillPath, "SKILL.md");

        try {
          const fileContent = await fs.readFile(skillFilePath, "utf-8");
          // Include source directory in the path for clarity
          const relativePath = path.relative(process.cwd(), path.join(skillsDir, skillPath));
          const skill = parseSkillFile(fileContent, relativePath);

          if (skill && !seenNames.has(skill.name)) {
            seenNames.add(skill.name);
            skillsList.push(skillToListItem(skill));
          }
        } catch (error) {
          // Skill directory exists but no valid SKILL.md, skip it
          logger.debug(`Skipping skill directory ${skillPath}: no valid SKILL.md`);
        }
      }
    }

    return c.json({ skills: skillsList });
  } catch (error) {
    logger.error("Error listing skills", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

/**
 * Get full skill content by name
 */
skills.post("/get", async (c) => {
  try {
    const { name } = (await c.req.json()) as { name?: string };

    if (!name) {
      return c.json({ success: false, error: "name is required" }, 400);
    }

    const skillsDirs = getSkillsDirs();

    // Search through all skills directories
    for (const skillsDir of skillsDirs) {
      // Check if this skills directory exists
      if (!(await directoryExists(skillsDir))) {
        continue;
      }

      const entries = await fs.readdir(skillsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillPath = entry.name;
        const skillFilePath = path.join(skillsDir, skillPath, "SKILL.md");

        try {
          const fileContent = await fs.readFile(skillFilePath, "utf-8");
          // Include source directory in the path for clarity
          const relativePath = path.relative(process.cwd(), path.join(skillsDir, skillPath));
          const skill = parseSkillFile(fileContent, relativePath);

          if (skill && skill.name === name) {
            return c.json({ skill });
          }
        } catch {
          // Continue searching
        }
      }
    }

    return c.json({ success: false, error: `Skill '${name}' not found` }, 404);
  } catch (error) {
    logger.error("Error getting skill", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

/**
 * Upload/create a new skill
 */
skills.post("/upload", async (c) => {
  try {
    const { name, description, content } = (await c.req.json()) as {
      name?: string;
      description?: string;
      content?: string;
    };

    if (!name) {
      return c.json({ success: false, error: "name is required" }, 400);
    }

    if (!description) {
      return c.json({ success: false, error: "description is required" }, 400);
    }

    if (!content) {
      return c.json({ success: false, error: "content is required" }, 400);
    }

    // Validate name format
    if (!isValidSkillName(name)) {
      return c.json(
        {
          success: false,
          error:
            "name must contain only lowercase letters, numbers, and hyphens",
        },
        400,
      );
    }

    // Check if skill already exists in any directory
    const skillsDirs = getSkillsDirs();
    for (const dir of skillsDirs) {
      if (await directoryExists(dir)) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const skillFilePath = path.join(dir, entry.name, "SKILL.md");
          try {
            const fileContent = await fs.readFile(skillFilePath, "utf-8");
            const existingSkill = parseSkillFile(fileContent, entry.name);
            if (existingSkill && existingSkill.name === name) {
              return c.json(
                { success: false, error: `Skill '${name}' already exists` },
                409,
              );
            }
          } catch {
            // Continue
          }
        }
      }
    }

    // Use primary skills directory for new uploads
    const skillsDir = getPrimarySkillsDir();
    const skillDir = path.join(skillsDir, name);
    const skillFilePath = path.join(skillDir, "SKILL.md");

    // Create skills directory if it doesn't exist
    await fs.mkdir(skillsDir, { recursive: true });

    // Create skill directory
    await fs.mkdir(skillDir, { recursive: true });

    // Generate and write SKILL.md content
    const fileContent = generateSkillFileContent(name, description, content);
    await fs.writeFile(skillFilePath, fileContent, "utf-8");

    const skill: Skill = {
      name,
      description,
      content,
      path: `~/.mcpjam/skills/${name}`,
    };

    return c.json({ success: true, skill });
  } catch (error) {
    logger.error("Error uploading skill", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

/**
 * Delete a skill by name
 */
skills.post("/delete", async (c) => {
  try {
    const { name } = (await c.req.json()) as { name?: string };

    if (!name) {
      return c.json({ success: false, error: "name is required" }, 400);
    }

    const skillsDirs = getSkillsDirs();

    // Search through all skills directories
    for (const skillsDir of skillsDirs) {
      // Check if this skills directory exists
      if (!(await directoryExists(skillsDir))) {
        continue;
      }

      const entries = await fs.readdir(skillsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillPath = entry.name;
        const skillFilePath = path.join(skillsDir, skillPath, "SKILL.md");

        try {
          const fileContent = await fs.readFile(skillFilePath, "utf-8");
          const skill = parseSkillFile(fileContent, skillPath);

          if (skill && skill.name === name) {
            // Delete the skill directory and its contents
            const skillDir = path.join(skillsDir, skillPath);
            await fs.rm(skillDir, { recursive: true, force: true });
            return c.json({ success: true });
          }
        } catch {
          // Continue searching
        }
      }
    }

    return c.json({ success: false, error: `Skill '${name}' not found` }, 404);
  } catch (error) {
    logger.error("Error deleting skill", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

export default skills;
