/**
 * Server-side skill tools for AI SDK
 *
 * These tools allow the LLM to load skills and access their supporting files on-demand.
 * They are compatible with AI SDK's tool format.
 */

import { tool } from "ai";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  parseSkillFile,
  listFilesRecursive,
  getMimeType,
  isTextMimeType,
  isPathWithinDirectory,
} from "./skill-parser";
import type { Skill, SkillListItem, SkillFile } from "../../shared/skill-types";
import type {
  RuntimeLocalSkill,
  RuntimeSkillFile,
} from "../services/environments/effective-capabilities.js";
import { LOCAL_SKILL_REF_NAMESPACE } from "../../shared/server-skill-refs";

/**
 * Get all skills directories
 */
function getSkillsDirs(): string[] {
  const homeDir = os.homedir();
  const cwd = process.cwd();

  return [
    // Global skills
    path.join(homeDir, ".claude", "skills"), // Claude Desktop global skills
    path.join(homeDir, ".mcpjam", "skills"),
    path.join(homeDir, ".agents", "skills"),
    // Project-local skills
    path.join(cwd, ".claude", "skills"), // Claude Desktop project skills
    path.join(cwd, ".mcpjam", "skills"),
    path.join(cwd, ".agents", "skills"),
  ];
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
 * List all available skills (metadata only)
 */
async function listSkillsMetadata(): Promise<SkillListItem[]> {
  const skillsDirs = getSkillsDirs();
  const skillsList: SkillListItem[] = [];
  const seenNames = new Set<string>();

  for (const skillsDir of skillsDirs) {
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
        const displayPath = formatDisplayPath(path.join(skillsDir, skillPath));
        const skill = parseSkillFile(fileContent, displayPath);

        if (skill && !seenNames.has(skill.name)) {
          seenNames.add(skill.name);
          skillsList.push({
            name: skill.name,
            description: skill.description,
            path: skill.path,
          });
        }
      } catch {
        // Skip invalid skills
      }
    }
  }

  return skillsList;
}

/**
 * Find skill directory by name
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
 * Get full skill content by name
 */
async function getSkillContent(name: string): Promise<Skill | null> {
  const skillDir = await findSkillDirectory(name);
  if (!skillDir) return null;

  const skillFilePath = path.join(skillDir, "SKILL.md");
  const fileContent = await fs.readFile(skillFilePath, "utf-8");
  const displayPath = formatDisplayPath(skillDir);

  return parseSkillFile(fileContent, displayPath);
}

/**
 * Format file tree for display
 */
function formatFileTree(files: SkillFile[], indent = ""): string {
  let result = "";
  for (const file of files) {
    if (file.type === "directory") {
      result += `${indent}${file.name}/\n`;
      if (file.children) {
        result += formatFileTree(file.children, indent + "  ");
      }
    } else {
      const size = file.size ? ` (${formatSize(file.size)})` : "";
      result += `${indent}${file.name}${size}\n`;
    }
  }
  return result;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * Flatten nested file structure
 */
function flattenFiles(files: SkillFile[]): SkillFile[] {
  const result: SkillFile[] = [];
  for (const file of files) {
    result.push(file);
    if (file.type === "directory" && file.children) {
      result.push(...flattenFiles(file.children));
    }
  }
  return result;
}

/**
 * Containment that survives a symlink.
 *
 * `isPathWithinDirectory` compares resolved STRINGS, so it stops `../` and
 * nothing else. A skills directory is ordinary user-writable space that
 * `npx skills` installs third-party packs into, and a symlinked `SKILL.md`
 * pointing at `~/.ssh/id_rsa` reads as an ordinary skill: its body would go
 * into the model's context with nothing in the file to notice. Instructions in
 * a malicious pack are at least legible; a symlink is silent, which is the
 * difference worth code.
 *
 * The BASE is resolved too, and that is load-bearing rather than tidy: a home
 * or temp directory is often reached through a symlink itself, so comparing a
 * resolved target against an unresolved base would refuse every read on those
 * machines.
 *
 * This closes `SKILL.md`, which is the only symlink the surface ever follows:
 * `readdir(withFileTypes)` reports a symlink as neither a file nor a
 * directory, so a symlinked skill directory or supporting file is already
 * skipped by the scan and the file lister. The check below stays on the file
 * read anyway — the listing's rules are not the read's proof.
 *
 * Returns the real path to read, or `null` when it lands outside (or does not
 * exist, which `realpath` reports the same way).
 */
async function realPathWithin(
  baseDir: string,
  target: string
): Promise<string | null> {
  try {
    const [base, resolved] = await Promise.all([
      fs.realpath(baseDir),
      fs.realpath(target),
    ]);
    return resolved === base || resolved.startsWith(base + path.sep)
      ? resolved
      : null;
  } catch {
    return null;
  }
}

/**
 * The local filesystem as one origin of an `EffectiveCapabilitySet`.
 *
 * This is what lets a desktop turn offer local files and project skills through
 * ONE ref-addressed catalog, instead of the exclusive either/or the chat
 * orchestrator used to pick between.
 *
 * Bodies are read eagerly — local disk is cheap and a skill without its body is
 * not a skill — but supporting FILES stay lazy: enumerating every skill's tree
 * on every turn would walk directories the model never asks about. The `read`
 * thunk keeps the traversal guard and the text/size caps that
 * `createSkillTools` already applies, so a local read through the effective
 * surface is bounded exactly like a local read through the bare one.
 */
export async function listLocalRuntimeSkills(): Promise<RuntimeLocalSkill[]> {
  const skills: RuntimeLocalSkill[] = [];
  const seenNames = new Set<string>();

  for (const skillsDir of getSkillsDirs()) {
    if (!(await directoryExists(skillsDir))) continue;

    let entries;
    try {
      entries = await fs.readdir(skillsDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(skillsDir, entry.name);
      try {
        const skillFile = await realPathWithin(
          skillDir,
          path.join(skillDir, "SKILL.md")
        );
        if (!skillFile) continue;
        const raw = await fs.readFile(skillFile, "utf-8");
        const parsed = parseSkillFile(raw, formatDisplayPath(skillDir));
        // First-wins across the search path, matching `listSkillsMetadata` —
        // two directories offering the same name is a shadowing question the
        // search order already answers, not a ref collision.
        if (!parsed || seenNames.has(parsed.name)) continue;
        seenNames.add(parsed.name);

        skills.push({
          skillId: `local:${skillDir}`,
          // Namespaced, so a local `code-review` and a project `code-review`
          // are separately addressable rather than one shadowing the other.
          // The bare name still resolves to the project skill — that IS its
          // ref, and `loadSkill` matches an exact ref before it considers
          // names — so namespacing costs the project skill nothing and buys
          // the local one an address it did not have.
          ref: `${LOCAL_SKILL_REF_NAMESPACE}/${parsed.name}`,
          name: parsed.name,
          description: parsed.description,
          content: parsed.content,
          aggregateHash: await localSkillAggregateHash(skillDir, parsed.content),
          directory: formatDisplayPath(skillDir),
          files: [],
          listFiles: () => listLocalRuntimeSkillFiles(skillDir),
        });
      } catch {
        // Not a readable skill directory; the bare surface skips these too.
      }
    }
  }

  return skills;
}

/**
 * Supporting files of one local skill, flattened to skill-relative paths.
 *
 * `SKILL.md` is excluded: it is the body, already delivered by `loadSkill`, and
 * listing it invites the model to spend a second read on what it just read.
 */
async function listLocalRuntimeSkillFiles(
  skillDir: string
): Promise<RuntimeSkillFile[]> {
  const tree = await listFilesRecursive(skillDir);
  return flattenFiles(tree)
    .filter((file) => file.type === "file" && file.path !== "SKILL.md")
    .map((file) => ({
      path: file.path,
      size: file.size ?? 0,
      url: null,
      read: async () => {
        // Belt and braces: the lister already drops symlinks, and the paths
        // come from that lister rather than from the model. Checked anyway,
        // because "the listing would never produce that" is an argument about
        // the caller, and this is the function that touches the disk.
        const absolute = await realPathWithin(
          skillDir,
          path.join(skillDir, file.path)
        );
        if (!absolute) {
          throw new Error(
            `"${file.path}" is not readable within the skill directory.`
          );
        }
        return new Uint8Array(await fs.readFile(absolute));
      },
    }));
}

/**
 * A content-plus-files hash, so the field means the same thing here as it does
 * for a cloud skill.
 *
 * Cloud skills fold their supporting files into `aggregateHash`; hashing only
 * the body under the same field name would make two origins disagree about what
 * the value covers, and any cross-origin comparison silently wrong. File
 * CONTENTS are deliberately not read — path and size are enough to notice a
 * file appearing, vanishing, or changing length, without a full directory read
 * per turn.
 */
async function localSkillAggregateHash(
  skillDir: string,
  content: string
): Promise<string> {
  let manifest = "";
  try {
    const tree = await listFilesRecursive(skillDir);
    manifest = flattenFiles(tree)
      .filter((file) => file.type === "file" && file.path !== "SKILL.md")
      .map((file) => `${file.path}:${file.size ?? 0}`)
      .sort()
      .join("\n");
  } catch {
    // An unreadable tree hashes as "no files" rather than failing the skill.
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${content}\n--\n${manifest}`)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Create skill tools for AI SDK
 * Returns tools that can be merged with MCP tools
 */
export function createSkillTools() {
  return {
    loadSkill: tool({
      description:
        "Load a skill's full content and instructions. Use when you need detailed guidance for a task that matches a skill's purpose. The skill content includes step-by-step instructions, examples, and references to supporting files.",
      inputSchema: z.object({
        name: z
          .string()
          .describe(
            "The skill name to load (e.g., 'pdf-processing', 'data-analysis')",
          ),
      }),
      execute: async ({ name }) => {
        // Validate skill name format (lowercase letters, numbers, and hyphens only)
        if (!/^[a-z0-9-]+$/.test(name)) {
          return `Error: Invalid skill name format "${name}". Skill names should contain only lowercase letters, numbers, and hyphens (e.g., 'pdf-processing', 'data-analysis').`;
        }

        try {
          const skill = await getSkillContent(name);
          if (!skill) {
            return `Error: Skill "${name}" not found.`;
          }

          let response = `# Skill: ${skill.name}\n\n${skill.content}`;

          // Add supporting files section if any exist
          const skillDir = await findSkillDirectory(name);
          if (skillDir) {
            const files = await listFilesRecursive(skillDir);
            const supportingFiles = flattenFiles(files).filter(
              (f) => f.name !== "SKILL.md" && f.type === "file",
            );

            if (supportingFiles.length > 0) {
              response += `\n\n## Supporting Files\n\nThis skill includes the following supporting files:\n\n`;
              response += formatFileTree(
                files.filter((f) => f.name !== "SKILL.md"),
              );
              response += `\nUse the \`listSkillFiles\` tool to explore directories and \`readSkillFile\` to read file contents.`;
            }
          }

          return response;
        } catch (error) {
          return `Error loading skill "${name}": ${error instanceof Error ? error.message : "Unknown error"}`;
        }
      },
    }),

    listSkillFiles: tool({
      description:
        "List all files and directories in a skill's directory. Use this to discover available rules, templates, or other supporting files that the skill provides.",
      inputSchema: z.object({
        name: z.string().describe("The skill name"),
      }),
      execute: async ({ name }) => {
        // Validate skill name format
        if (!/^[a-z0-9-]+$/.test(name)) {
          return `Error: Invalid skill name format "${name}". Skill names should contain only lowercase letters, numbers, and hyphens.`;
        }

        try {
          const skillDir = await findSkillDirectory(name);
          if (!skillDir) {
            return `Error: Skill "${name}" not found.`;
          }

          const files = await listFilesRecursive(skillDir);
          if (files.length === 0) {
            return `No files found in skill "${name}".`;
          }

          let response = `Files in skill "${name}":\n\n`;
          response += formatFileTree(files);
          return response;
        } catch (error) {
          return `Error listing files for skill "${name}": ${error instanceof Error ? error.message : "Unknown error"}`;
        }
      },
    }),

    readSkillFile: tool({
      description:
        "Read the content of a specific file from a skill directory. Use this to access rules, templates, or other supporting resources referenced in the skill instructions.",
      inputSchema: z.object({
        name: z.string().describe("The skill name"),
        path: z
          .string()
          .describe(
            "Relative file path within the skill directory (e.g., 'scripts/process.py', 'templates/form.html')",
          ),
      }),
      execute: async ({ name, path: filePath }) => {
        // Validate skill name format
        if (!/^[a-z0-9-]+$/.test(name)) {
          return `Error: Invalid skill name format "${name}". Skill names should contain only lowercase letters, numbers, and hyphens.`;
        }

        try {
          const skillDir = await findSkillDirectory(name);
          if (!skillDir) {
            return `Error: Skill "${name}" not found.`;
          }

          // Security: Validate path doesn't escape skill directory
          if (!isPathWithinDirectory(skillDir, filePath)) {
            return `Error: Invalid file path.`;
          }

          const fullPath = path.join(skillDir, filePath);

          try {
            const stat = await fs.stat(fullPath);
            if (!stat.isFile()) {
              return `Error: "${filePath}" is not a file.`;
            }

            const mimeType = getMimeType(filePath);
            const isText = isTextMimeType(mimeType);

            // Limit file size to 1MB for text
            if (stat.size > 1024 * 1024) {
              return `Error: File too large (${formatSize(stat.size)}). Maximum is 1MB.`;
            }

            if (!isText) {
              return `File "${filePath}" is a binary file (${mimeType}, ${formatSize(stat.size)}). Cannot display content directly.`;
            }

            const content = await fs.readFile(fullPath, "utf-8");
            return `# File: ${filePath}\n\n\`\`\`\n${content}\n\`\`\``;
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
              return `Error: File "${filePath}" not found in skill "${name}".`;
            }
            throw err;
          }
        } catch (error) {
          return `Error reading file "${filePath}" from skill "${name}": ${error instanceof Error ? error.message : "Unknown error"}`;
        }
      },
    }),
  };
}

/**
 * Build the available skills section for the system prompt
 */
export async function buildSkillsSystemPromptSection(): Promise<string> {
  const skills = await listSkillsMetadata();

  if (skills.length === 0) {
    return "";
  }

  let section = `\n\n## Available Skills\n\n`;
  section += `You have access to the following skills. When a task matches a skill's purpose, use the \`loadSkill\` tool to load its full instructions:\n\n`;

  for (const skill of skills) {
    section += `- **${skill.name}**: ${skill.description}\n`;
  }

  section += `\nAfter loading a skill, you can use \`listSkillFiles\` and \`readSkillFile\` to access any supporting files (rules, templates, etc.) that the skill provides.`;

  return section;
}

/**
 * Get skill tools and system prompt section together
 * Only returns tools if there are skills available
 */
export async function getSkillToolsAndPrompt() {
  const skills = await listSkillsMetadata();

  // Only add skill tools and prompt section if there are skills loaded
  if (skills.length === 0) {
    return {
      tools: {},
      systemPromptSection: "",
    };
  }

  const tools = createSkillTools();

  // Build prompt section from the already-fetched skills list
  let systemPromptSection = `\n\n## Available Skills\n\n`;
  systemPromptSection += `You have access to the following skills. When a task matches a skill's purpose, use the \`loadSkill\` tool to load its full instructions:\n\n`;

  for (const skill of skills) {
    systemPromptSection += `- **${skill.name}**: ${skill.description}\n`;
  }

  systemPromptSection += `\nAfter loading a skill, you can use \`listSkillFiles\` and \`readSkillFile\` to access any supporting files (rules, templates, etc.) that the skill provides.`;

  return {
    tools,
    systemPromptSection,
  };
}
