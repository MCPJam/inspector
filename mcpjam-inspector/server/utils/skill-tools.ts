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
