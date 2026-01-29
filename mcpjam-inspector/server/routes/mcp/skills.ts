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
  listFilesRecursive,
  getMimeType,
  isTextMimeType,
  isPathWithinDirectory,
} from "../../utils/skill-parser";
import type {
  Skill,
  SkillListItem,
  SkillFile,
  SkillFileContent,
} from "../../../shared/skill-types";

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
    path.join(homeDir, ".claude", "skills"), // Claude Desktop global skills
    path.join(homeDir, ".mcpjam", "skills"), // MCPJam global skills
    path.join(homeDir, ".agents", "skills"), // npx skills global installs

    // Project-local skills (when launched from project directory)
    path.join(cwd, ".claude", "skills"), // Claude Desktop project skills
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
 * Format skill path for display - use ~ for home directory paths
 */
function formatDisplayPath(fullPath: string): string {
  const homeDir = os.homedir();
  if (fullPath.startsWith(homeDir)) {
    return fullPath.replace(homeDir, "~");
  }
  return path.relative(process.cwd(), fullPath);
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
 * Find the directory path for a skill by name
 * Returns the full path to the skill directory, or null if not found
 */
async function findSkillDirectory(name: string): Promise<string | null> {
  const skillsDirs = getSkillsDirs();

  for (const skillsDir of skillsDirs) {
    if (!(await directoryExists(skillsDir))) {
      continue;
    }

    const entries = await fs.readdir(skillsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillDir = path.join(skillsDir, entry.name);
      const skillFilePath = path.join(skillDir, "SKILL.md");

      try {
        const fileContent = await fs.readFile(skillFilePath, "utf-8");
        const skill = parseSkillFile(fileContent, entry.name);

        if (skill && skill.name === name) {
          return skillDir;
        }
      } catch {
        // Continue searching
      }
    }
  }

  return null;
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
          const displayPath = formatDisplayPath(
            path.join(skillsDir, skillPath),
          );
          const skill = parseSkillFile(fileContent, displayPath);

          if (skill && !seenNames.has(skill.name)) {
            seenNames.add(skill.name);
            skillsList.push(skillToListItem(skill));
          }
        } catch (error) {
          // Skill directory exists but no valid SKILL.md, skip it
          logger.debug(
            `Skipping skill directory ${skillPath}: no valid SKILL.md`,
          );
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
          const displayPath = formatDisplayPath(
            path.join(skillsDir, skillPath),
          );
          const skill = parseSkillFile(fileContent, displayPath);

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
 * Upload a skill folder with multiple files (multipart/form-data)
 */
skills.post("/upload-folder", async (c) => {
  try {
    const formData = await c.req.formData();
    const skillName = formData.get("skillName") as string | null;
    const files = formData.getAll("files") as File[];

    if (!skillName) {
      return c.json({ success: false, error: "skillName is required" }, 400);
    }

    if (!files || files.length === 0) {
      return c.json({ success: false, error: "No files uploaded" }, 400);
    }

    // Validate skill name format
    if (!isValidSkillName(skillName)) {
      return c.json(
        {
          success: false,
          error:
            "Skill name must contain only lowercase letters, numbers, and hyphens",
        },
        400,
      );
    }

    // Find SKILL.md file
    const skillMdFile = files.find(
      (f) => f.name === "SKILL.md" || f.name.endsWith("/SKILL.md"),
    );

    if (!skillMdFile) {
      return c.json(
        { success: false, error: "No SKILL.md file found in uploaded files" },
        400,
      );
    }

    // Parse and validate SKILL.md
    const skillMdContent = await skillMdFile.text();
    const parsedSkill = parseSkillFile(skillMdContent, skillName);

    if (!parsedSkill) {
      return c.json(
        {
          success: false,
          error:
            "Invalid SKILL.md format. Must contain valid frontmatter with 'name' and 'description' fields.",
        },
        400,
      );
    }

    // Verify the name in SKILL.md matches the provided skillName
    if (parsedSkill.name !== skillName) {
      return c.json(
        {
          success: false,
          error: `Skill name mismatch: provided "${skillName}" but SKILL.md contains "${parsedSkill.name}"`,
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
            if (existingSkill && existingSkill.name === skillName) {
              return c.json(
                {
                  success: false,
                  error: `Skill '${skillName}' already exists`,
                },
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
    const skillDir = path.join(skillsDir, skillName);

    // Create skills directory if it doesn't exist
    await fs.mkdir(skillsDir, { recursive: true });

    // Create skill directory
    await fs.mkdir(skillDir, { recursive: true });

    // Write all files
    for (const file of files) {
      const fileName = file.name;

      // Security: Validate path doesn't try to escape skill directory
      if (!isPathWithinDirectory(skillDir, fileName)) {
        logger.warn(`Skipping file with invalid path: ${fileName}`);
        continue;
      }

      const filePath = path.join(skillDir, fileName);
      const fileDir = path.dirname(filePath);

      // Create subdirectories if needed
      await fs.mkdir(fileDir, { recursive: true });

      // Write file content
      const buffer = Buffer.from(await file.arrayBuffer());
      await fs.writeFile(filePath, buffer);
    }

    const skill: Skill = {
      name: parsedSkill.name,
      description: parsedSkill.description,
      content: parsedSkill.content,
      path: `~/.mcpjam/skills/${skillName}`,
    };

    return c.json({ success: true, skill });
  } catch (error) {
    logger.error("Error uploading skill folder", error);
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

/**
 * List all files in a skill directory
 */
skills.post("/files", async (c) => {
  try {
    const { name } = (await c.req.json()) as { name?: string };

    if (!name) {
      return c.json({ success: false, error: "name is required" }, 400);
    }

    const skillDir = await findSkillDirectory(name);
    if (!skillDir) {
      return c.json(
        { success: false, error: `Skill '${name}' not found` },
        404,
      );
    }

    const files = await listFilesRecursive(skillDir);
    return c.json({ files });
  } catch (error) {
    logger.error("Error listing skill files", error);
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
 * Read a specific file from a skill directory
 */
skills.post("/read-file", async (c) => {
  try {
    const { name, filePath } = (await c.req.json()) as {
      name?: string;
      filePath?: string;
    };

    if (!name) {
      return c.json({ success: false, error: "name is required" }, 400);
    }

    if (!filePath) {
      return c.json({ success: false, error: "filePath is required" }, 400);
    }

    const skillDir = await findSkillDirectory(name);
    if (!skillDir) {
      return c.json(
        { success: false, error: `Skill '${name}' not found` },
        404,
      );
    }

    // Security: Validate path doesn't escape skill directory
    if (!isPathWithinDirectory(skillDir, filePath)) {
      return c.json({ success: false, error: "Invalid file path" }, 400);
    }

    const fullPath = path.join(skillDir, filePath);

    // Check if file exists
    try {
      const stat = await fs.stat(fullPath);
      if (!stat.isFile()) {
        return c.json({ success: false, error: "Path is not a file" }, 400);
      }

      const mimeType = getMimeType(filePath);
      const isText = isTextMimeType(mimeType);
      const fileName = path.basename(filePath);

      const fileContent: SkillFileContent = {
        path: filePath,
        name: fileName,
        mimeType,
        size: stat.size,
        isText,
      };

      // Limit file size to 1MB for text, 5MB for binary
      const maxSize = isText ? 1024 * 1024 : 5 * 1024 * 1024;
      if (stat.size > maxSize) {
        return c.json(
          {
            success: false,
            error: `File too large (${(stat.size / 1024 / 1024).toFixed(2)}MB). Maximum is ${maxSize / 1024 / 1024}MB`,
          },
          400,
        );
      }

      if (isText) {
        fileContent.content = await fs.readFile(fullPath, "utf-8");
      } else {
        const buffer = await fs.readFile(fullPath);
        fileContent.base64 = buffer.toString("base64");
      }

      return c.json({ file: fileContent });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return c.json({ success: false, error: "File not found" }, 404);
      }
      throw err;
    }
  } catch (error) {
    logger.error("Error reading skill file", error);
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
