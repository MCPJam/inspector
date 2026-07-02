/**
 * Cloud skill tools for the AI SDK — hosted/`/web` chat. Reads the project's
 * durable skills from Convex (`cloud-skills.ts`), NOT the Computer filesystem,
 * so listing/loading never wakes a sandbox.
 *
 * Progressive disclosure: we advertise a cheap `listSkills` discovery tool plus
 * `loadSkill`; the model pulls a skill's full instructions only when a task
 * matches. v1 is SKILL.md-only (no supporting-file tools yet). When the tools are
 * wired is decided by `shouldEnableCloudSkillTools` (see `web/chat-v2.ts`).
 */
import { tool } from "ai";
import { z } from "zod";
import { isMCPJamProvidedModel } from "@/shared/types";
import {
  CloudSkillsError,
  getCloudSkillByName,
  listCloudSkills,
  type CloudSkillsContext,
} from "./cloud-skills.js";

const NAME_RE = /^[a-z0-9-]+$/;

/**
 * Whether the emulated chat path should advertise the cloud skill tools.
 *
 * Cloud skills are a Convex-backed PROJECT resource (no computer required), so
 * any signed-in member with a project gets them — EXCEPT when the turn will run
 * the real Claude Code harness, which delivers skills via the adapter `skills`
 * param instead (advertising the tools there would be a prompt/tool mismatch).
 *
 * The harness runs ONLY for a `harness:"claude-code"` host on an MCPJam-provided
 * model; a BYOK model on that same host runs emulated — so gate on the actual
 * engine (model), not host config alone.
 */
export function shouldEnableCloudSkillTools(args: {
  isGuest: boolean;
  harness: string | undefined;
  modelId: string;
  hasProjectId: boolean;
}): boolean {
  const willRunHarness =
    args.harness === "claude-code" && isMCPJamProvidedModel(args.modelId);
  return !args.isGuest && !willRunHarness && args.hasProjectId;
}

function errMessage(err: unknown): string {
  if (err instanceof CloudSkillsError) return err.message;
  return err instanceof Error ? err.message : "Unknown error";
}

export function createCloudSkillTools(ctx: CloudSkillsContext) {
  return {
    listSkills: tool({
      description:
        "List the skills available to you in this project (personal + shared). Returns each skill's name and description. Call this first to discover what's available, then `loadSkill` to load one.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const skills = await listCloudSkills(ctx);
          if (skills.length === 0) {
            return "No skills are available in this project.";
          }
          return (
            `Available skills:\n\n` +
            skills
              .map(
                (s) =>
                  `- **${s.name}** (${
                    s.sharing === "project" ? "shared" : "personal"
                  }): ${s.description}`
              )
              .join("\n")
          );
        } catch (err) {
          return `Error listing skills: ${errMessage(err)}`;
        }
      },
    }),

    loadSkill: tool({
      description:
        "Load a skill's full instructions by name. Use when a task matches a skill's purpose.",
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
          const skill = await getCloudSkillByName(ctx, name);
          if (!skill) return `Error: Skill "${name}" not found.`;
          return `# Skill: ${skill.name}\n\n${skill.content}`;
        } catch (err) {
          return `Error loading skill "${name}": ${errMessage(err)}`;
        }
      },
    }),
  };
}

const CLOUD_SKILLS_PROMPT_SECTION =
  `\n\n## Skills\n\n` +
  `This project may have skills available to you (personal + shared) — reusable ` +
  `instruction packages for specific tasks. Call the \`listSkills\` tool to see ` +
  `what's available, then \`loadSkill\` to load a skill's full instructions when ` +
  `a task matches its purpose.`;

/**
 * Cloud equivalent of `getSkillToolsAndPrompt`. Always returns the tools +
 * prompt section (the gate is "host has a computer + non-guest", enforced by the
 * caller); discovery is lazy via `listSkills` (a cheap Convex read).
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
