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
import {
  getSharedProjectSkillsCacheDir,
  readLocalSkillBundle,
  syncSharedProjectSkills,
} from "../../services/project-skills-sync";
import { ConvexHttpClient } from "convex/browser";

const skills = new Hono();

/**
 * Read the optional `projectId` request hint that lets project-aware callers
 * include the shared project skills cache in their search path. Local
 * uploads, deletes, and unscoped listings stay backwards-compatible by
 * leaving `projectId` undefined.
 */
function readProjectIdHint(body: unknown): string | undefined {
  if (
    body &&
    typeof body === "object" &&
    "projectId" in body &&
    typeof (body as { projectId?: unknown }).projectId === "string"
  ) {
    const value = (body as { projectId: string }).projectId;
    if (/^[A-Za-z0-9_-]+$/.test(value)) return value;
  }
  return undefined;
}

/**
 * Get all skills directories as absolute paths.
 *
 * Skills can come from:
 * 1. Global user skills: ~/.claude/skills/, ~/.mcpjam/skills/, ~/.agents/skills/
 * 2. Shared project skills cache: ~/.mcpjam/projects/<projectId>/skills/
 * 3. Project-local skills: .claude/skills/, .mcpjam/skills/, .agents/skills/
 *
 * Order matters: first match wins for `findSkillDirectory`, so a global
 * personal skill with the same name as a shared project skill overrides the
 * shared copy. This keeps surprise low for users who already had a local
 * skill named the same thing before joining the project.
 */
function getSkillsDirs(projectId?: string): string[] {
  const homeDir = os.homedir();
  const cwd = process.cwd();

  const dirs: string[] = [
    // Global skills (always accessible regardless of how app is launched)
    path.join(homeDir, ".claude", "skills"), // Claude Desktop global skills
    path.join(homeDir, ".mcpjam", "skills"), // MCPJam global skills
    path.join(homeDir, ".agents", "skills"), // npx skills global installs
  ];

  // Shared project cache slot — populated by syncSharedProjectSkills(). Sits
  // between global personal skills and project-local skills so a user's own
  // global override wins, but the shared cache still beats per-cwd files.
  if (projectId) {
    dirs.push(getSharedProjectSkillsCacheDir(projectId));
  }

  // Project-local skills (when launched from project directory)
  dirs.push(
    path.join(cwd, ".claude", "skills"), // Claude Desktop project skills
    path.join(cwd, ".mcpjam", "skills"),
    path.join(cwd, ".agents", "skills"),
  );

  return dirs;
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
async function findSkillDirectory(
  name: string,
  projectId?: string,
): Promise<string | null> {
  const skillsDirs = getSkillsDirs(projectId);

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
    // Body is optional for backwards compatibility — older clients post `{}`.
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    const projectId = readProjectIdHint(body);
    const skillsDirs = getSkillsDirs(projectId);
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
    const body = (await c.req.json()) as {
      name?: string;
      projectId?: string;
    };
    const { name } = body;

    if (!name) {
      return c.json({ success: false, error: "name is required" }, 400);
    }

    const projectId = readProjectIdHint(body);
    const skillsDirs = getSkillsDirs(projectId);

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
    const body = (await c.req.json()) as {
      name?: string;
      projectId?: string;
    };
    const { name } = body;

    if (!name) {
      return c.json({ success: false, error: "name is required" }, 400);
    }

    const skillDir = await findSkillDirectory(name, readProjectIdHint(body));
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
    const body = (await c.req.json()) as {
      name?: string;
      filePath?: string;
      projectId?: string;
    };
    const { name, filePath } = body;

    if (!name) {
      return c.json({ success: false, error: "name is required" }, 400);
    }

    if (!filePath) {
      return c.json({ success: false, error: "filePath is required" }, 400);
    }

    const skillDir = await findSkillDirectory(name, readProjectIdHint(body));
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

/**
 * Build a project-scoped Convex client using the auth token the client
 * already plumbs through for other authenticated endpoints. Returns null and
 * a 400-shaped error if either piece is missing — these endpoints only make
 * sense when the inspector is signed in and aware of its project.
 */
function buildProjectConvexClient(opts: {
  convexAuthToken?: string;
}): ConvexHttpClient | null {
  const url = process.env.CONVEX_URL;
  if (!url || !opts.convexAuthToken) return null;
  const client = new ConvexHttpClient(url);
  client.setAuth(opts.convexAuthToken);
  return client;
}

/**
 * List active shared skills for a project from Convex (separate from the
 * filesystem `/list` route so the popover can render shared vs local in
 * different sections without one masking the other).
 */
skills.post("/list-project", async (c) => {
  try {
    const body = (await c.req.json()) as {
      projectId?: string;
      convexAuthToken?: string;
    };
    if (!body.projectId) {
      return c.json({ success: false, error: "projectId is required" }, 400);
    }
    const client = buildProjectConvexClient(body);
    if (!client) {
      return c.json(
        {
          success: false,
          error:
            "Project-shared skills require a signed-in Convex session (set CONVEX_URL and pass convexAuthToken)",
        },
        400,
      );
    }
    const summaries = await client.query(
      "projectSkills:listProjectSkills" as any,
      { projectId: body.projectId },
    );
    return c.json({ skills: summaries });
  } catch (error) {
    logger.error("Error listing project skills", error);
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
 * Sync the local cache for a project with Convex. Idempotent: re-callable
 * after every popover open or after publish/update/archive to keep the
 * filesystem cache and the canonical Convex copy in sync.
 */
skills.post("/sync-project", async (c) => {
  try {
    const body = (await c.req.json()) as {
      projectId?: string;
      convexAuthToken?: string;
    };
    if (!body.projectId) {
      return c.json({ success: false, error: "projectId is required" }, 400);
    }
    if (!body.convexAuthToken) {
      return c.json(
        { success: false, error: "convexAuthToken is required" },
        400,
      );
    }
    const result = await syncSharedProjectSkills(
      body.projectId,
      body.convexAuthToken,
    );
    return c.json({ success: true, ...result });
  } catch (error) {
    logger.error("Error syncing project skills", error);
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
 * Publish a locally-stored skill to a project. The local copy stays where it
 * is — this only copies the skill bundle into Convex so other members can
 * sync it. Callers identify the local skill by name; we look it up in the
 * filesystem precedence chain (NOT including the shared cache, since that
 * would let us "publish" a copy of someone else's shared skill).
 */
skills.post("/publish-to-project", async (c) => {
  try {
    const body = (await c.req.json()) as {
      projectId?: string;
      convexAuthToken?: string;
      name?: string;
      // Optional override so the published copy can use a different name (for
      // collision resolution). The on-disk local skill is NOT renamed.
      publishAs?: string;
    };

    if (!body.projectId) {
      return c.json({ success: false, error: "projectId is required" }, 400);
    }
    if (!body.convexAuthToken) {
      return c.json(
        { success: false, error: "convexAuthToken is required" },
        400,
      );
    }
    if (!body.name) {
      return c.json({ success: false, error: "name is required" }, 400);
    }
    const publishName = body.publishAs ?? body.name;
    if (!isValidSkillName(publishName)) {
      return c.json(
        { success: false, error: `Invalid publish name: ${publishName}` },
        400,
      );
    }

    // Resolve to the local-only filesystem dirs (no projectId here).
    const localDir = await findSkillDirectory(body.name);
    if (!localDir) {
      return c.json(
        { success: false, error: `Skill '${body.name}' not found locally` },
        404,
      );
    }

    const skillMdRaw = await fs.readFile(
      path.join(localDir, "SKILL.md"),
      "utf-8",
    );
    const parsed = parseSkillFile(skillMdRaw, localDir);
    if (!parsed) {
      return c.json(
        {
          success: false,
          error: "Local SKILL.md is not valid; cannot publish",
        },
        400,
      );
    }

    const { skillMd, files } = await readLocalSkillBundle(localDir);

    // If publishing under a different name, rewrite the frontmatter `name`
    // field so the materialized copy matches the published name on disk.
    const normalizedSkillMd =
      publishName === parsed.name
        ? skillMd
        : skillMd.replace(
            /(^---[\s\S]*?^name:\s*)([^\n]+)(\n)/m,
            `$1${publishName}$3`,
          );

    const client = buildProjectConvexClient(body);
    if (!client) {
      return c.json(
        {
          success: false,
          error:
            "Project-shared skills require a signed-in Convex session (set CONVEX_URL)",
        },
        400,
      );
    }

    try {
      const detail = await client.mutation(
        "projectSkills:publishProjectSkill" as any,
        {
          projectId: body.projectId,
          name: publishName,
          description: parsed.description,
          skillMd: normalizedSkillMd,
          files,
        },
      );
      return c.json({ success: true, skill: detail });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Surface structured nameCollision so the popover/dialog can render
      // the rename-and-publish affordance without parsing free text.
      const match = message.match(/\{[^}]*nameCollision[^}]*\}/);
      if (match) {
        try {
          const payload = JSON.parse(match[0]);
          if (payload.code === "nameCollision") {
            return c.json(
              {
                success: false,
                error: payload.message,
                code: "nameCollision",
              },
              409,
            );
          }
        } catch {
          // fall through
        }
      }
      throw err;
    }
  } catch (error) {
    logger.error("Error publishing project skill", error);
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
 * Push an updated copy of a locally-stored skill to its existing published
 * row in Convex. Only the creator is allowed — Convex enforces this server-
 * side too, but we surface the failure here for a nicer error.
 */
skills.post("/update-published", async (c) => {
  try {
    const body = (await c.req.json()) as {
      skillId?: string;
      convexAuthToken?: string;
      // The local skill directory name to read from (defaults to the same
      // name the published copy uses).
      sourceName?: string;
    };
    if (!body.skillId) {
      return c.json({ success: false, error: "skillId is required" }, 400);
    }
    if (!body.convexAuthToken) {
      return c.json(
        { success: false, error: "convexAuthToken is required" },
        400,
      );
    }
    if (!body.sourceName) {
      return c.json(
        { success: false, error: "sourceName is required" },
        400,
      );
    }

    const localDir = await findSkillDirectory(body.sourceName);
    if (!localDir) {
      return c.json(
        {
          success: false,
          error: `Local skill '${body.sourceName}' not found`,
        },
        404,
      );
    }
    const skillMdRaw = await fs.readFile(
      path.join(localDir, "SKILL.md"),
      "utf-8",
    );
    const parsed = parseSkillFile(skillMdRaw, localDir);
    if (!parsed) {
      return c.json(
        { success: false, error: "Local SKILL.md is not valid" },
        400,
      );
    }
    const { skillMd, files } = await readLocalSkillBundle(localDir);

    const client = buildProjectConvexClient(body);
    if (!client) {
      return c.json(
        { success: false, error: "Project-shared skills require Convex" },
        400,
      );
    }
    const detail = await client.mutation(
      "projectSkills:updateProjectSkill" as any,
      {
        skillId: body.skillId,
        description: parsed.description,
        skillMd,
        files,
      },
    );
    return c.json({ success: true, skill: detail });
  } catch (error) {
    logger.error("Error updating published skill", error);
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
 * Archive (unshare) a published project skill. Creator or project admin/
 * owner can do this — Convex is authoritative on the permission check.
 */
skills.post("/archive-published", async (c) => {
  try {
    const body = (await c.req.json()) as {
      skillId?: string;
      convexAuthToken?: string;
    };
    if (!body.skillId) {
      return c.json({ success: false, error: "skillId is required" }, 400);
    }
    if (!body.convexAuthToken) {
      return c.json(
        { success: false, error: "convexAuthToken is required" },
        400,
      );
    }
    const client = buildProjectConvexClient(body);
    if (!client) {
      return c.json(
        { success: false, error: "Project-shared skills require Convex" },
        400,
      );
    }
    await client.mutation("projectSkills:archiveProjectSkill" as any, {
      skillId: body.skillId,
    });
    return c.json({ success: true });
  } catch (error) {
    logger.error("Error archiving published skill", error);
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
