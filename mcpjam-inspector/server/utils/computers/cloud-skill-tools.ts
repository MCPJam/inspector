/**
 * Cloud skill tools for the AI SDK — the hosted/`/web` chat counterpart of
 * `server/utils/skill-tools.ts`. Where the local tools read the inspector's
 * own filesystem, these read the caller's **Computer** (E2B sandbox) via
 * `cloud-skills.ts`.
 *
 * Progressive disclosure, hosted-aware: unlike the local path we do NOT
 * pre-list skills into the system prompt, because listing reads the computer's
 * filesystem and would force a sandbox **wake** on every turn — even when the
 * user never touches a skill. Instead we advertise a cheap `listSkills`
 * discovery tool; the model wakes the box only when it decides to look. This
 * keeps "advertise == enforce": the tools are only wired in when the host
 * actually has a computer (see `chat-v2-orchestration.ts`).
 */
import { tool } from "ai";
import { z } from "zod";
import {
  CloudSkillsError,
  listCloudSkills,
  getCloudSkill,
  listCloudSkillFiles,
  readCloudSkillFile,
  type CloudSkillsContext,
} from "./cloud-skills.js";
import type { SkillFile } from "../../../shared/skill-types.js";

const NAME_RE = /^[a-z0-9-]+$/;

function errMessage(err: unknown): string {
  if (err instanceof CloudSkillsError) return err.message;
  return err instanceof Error ? err.message : "Unknown error";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function formatFileTree(files: SkillFile[], indent = ""): string {
  let result = "";
  for (const file of files) {
    if (file.type === "directory") {
      result += `${indent}${file.name}/\n`;
      if (file.children) result += formatFileTree(file.children, indent + "  ");
    } else {
      const size = file.size ? ` (${formatSize(file.size)})` : "";
      result += `${indent}${file.name}${size}\n`;
    }
  }
  return result;
}

function flattenFiles(files: SkillFile[]): SkillFile[] {
  const out: SkillFile[] = [];
  for (const file of files) {
    out.push(file);
    if (file.type === "directory" && file.children) {
      out.push(...flattenFiles(file.children));
    }
  }
  return out;
}

export function createCloudSkillTools(ctx: CloudSkillsContext) {
  return {
    listSkills: tool({
      description:
        "List the skills installed on your computer (reusable instruction packages). Returns each skill's name and description. Call this first to discover what skills are available, then `loadSkill` to load one.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const skills = await listCloudSkills(ctx);
          if (skills.length === 0) {
            return "No skills are installed on your computer.";
          }
          return (
            `Available skills:\n\n` +
            skills.map((s) => `- **${s.name}**: ${s.description}`).join("\n")
          );
        } catch (err) {
          return `Error listing skills: ${errMessage(err)}`;
        }
      },
    }),

    loadSkill: tool({
      description:
        "Load a skill's full content and instructions from your computer. Use when a task matches a skill's purpose.",
      inputSchema: z.object({
        name: z
          .string()
          .describe("The skill name to load (e.g., 'pdf-processing')."),
      }),
      execute: async ({ name }) => {
        if (!NAME_RE.test(name)) {
          return `Error: Invalid skill name format "${name}". Skill names contain only lowercase letters, numbers, and hyphens.`;
        }
        try {
          const skill = await getCloudSkill(ctx, name);
          if (!skill) return `Error: Skill "${name}" not found.`;

          let response = `# Skill: ${skill.name}\n\n${skill.content}`;
          const files = await listCloudSkillFiles(ctx, name).catch(
            () => [] as SkillFile[],
          );
          const supporting = flattenFiles(files).filter(
            (f) => f.name !== "SKILL.md" && f.type === "file",
          );
          if (supporting.length > 0) {
            response += `\n\n## Supporting Files\n\nThis skill includes the following supporting files:\n\n`;
            response += formatFileTree(
              files.filter((f) => f.name !== "SKILL.md"),
            );
            response += `\nUse the \`listSkillFiles\` tool to explore directories and \`readSkillFile\` to read file contents.`;
          }
          return response;
        } catch (err) {
          return `Error loading skill "${name}": ${errMessage(err)}`;
        }
      },
    }),

    listSkillFiles: tool({
      description:
        "List all files and directories in a skill's directory on your computer.",
      inputSchema: z.object({
        name: z.string().describe("The skill name"),
      }),
      execute: async ({ name }) => {
        if (!NAME_RE.test(name)) {
          return `Error: Invalid skill name format "${name}".`;
        }
        try {
          const files = await listCloudSkillFiles(ctx, name);
          if (files.length === 0) return `No files found in skill "${name}".`;
          return `Files in skill "${name}":\n\n${formatFileTree(files)}`;
        } catch (err) {
          return `Error listing files for skill "${name}": ${errMessage(err)}`;
        }
      },
    }),

    readSkillFile: tool({
      description:
        "Read the content of a specific file from a skill directory on your computer.",
      inputSchema: z.object({
        name: z.string().describe("The skill name"),
        path: z
          .string()
          .describe("Relative file path within the skill (e.g. 'scripts/run.py')."),
      }),
      execute: async ({ name, path: filePath }) => {
        if (!NAME_RE.test(name)) {
          return `Error: Invalid skill name format "${name}".`;
        }
        try {
          const file = await readCloudSkillFile(ctx, name, filePath);
          if (!file.isText) {
            return `File "${filePath}" is a binary file (${file.mimeType}, ${formatSize(file.size)}). Cannot display content directly.`;
          }
          return `# File: ${filePath}\n\n\`\`\`\n${file.content ?? ""}\n\`\`\``;
        } catch (err) {
          return `Error reading file "${filePath}" from skill "${name}": ${errMessage(err)}`;
        }
      },
    }),
  };
}

const CLOUD_SKILLS_PROMPT_SECTION =
  `\n\n## Skills (on your personal computer)\n\n` +
  `Your personal computer may have skills installed — reusable instruction ` +
  `packages for specific tasks. Call the \`listSkills\` tool to see what's available, then ` +
  `\`loadSkill\` to load a skill's full instructions when a task matches its ` +
  `purpose. After loading, use \`listSkillFiles\` and \`readSkillFile\` to access ` +
  `any supporting files (rules, templates, scripts) the skill provides.`;

/**
 * Cloud equivalent of `getSkillToolsAndPrompt`. Always returns the tools +
 * prompt section (the gate is "host has a computer", enforced by the caller);
 * discovery is lazy via `listSkills` so no sandbox wake happens up front.
 */
export function getCloudSkillToolsAndPrompt(ctx: CloudSkillsContext): {
  tools: ReturnType<typeof createCloudSkillTools>;
  systemPromptSection: string;
} {
  return {
    tools: createCloudSkillTools(ctx),
    systemPromptSection: CLOUD_SKILLS_PROMPT_SECTION,
  };
}
