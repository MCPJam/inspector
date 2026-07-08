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
import type { PinnableSkill } from "../../../shared/skill-types.js";
import {
  CloudSkillsError,
  getCloudSkillByName,
  listCloudSkills,
  listCloudSkillFiles,
  readCloudSkillFile,
  type CloudSkillsContext,
} from "./cloud-skills.js";

const NAME_RE = /^[a-z0-9-]+$/;

/**
 * Whether the emulated chat path should advertise the cloud skill tools.
 *
 * Cloud skills are a Convex-backed PROJECT resource (no computer required), so
 * any signed-in member with a project gets them — EXCEPT when the turn will run
 * a real harness runtime, which delivers skills via the adapter `skills` param
 * (or, for skills-incapable runtimes like Codex, not at all) — advertising the
 * emulated tools there would be a prompt/tool mismatch.
 *
 * Two footguns this check must not regress on:
 *  - `provider` is REQUIRED for the model check: bare hosted ids
 *    (`gpt-5-nano` + `openai`) only canonicalize to their prefixed form with
 *    the provider, and a provider-blind check would advertise the emulated
 *    tools into a real harness turn.
 *  - Gate on ANY harness id, not the `claude-code` literal — a Codex host on
 *    an MCPJam model runs the Codex harness, not the emulated engine.
 *
 * A BYOK model on a harness host does NOT reach the harness (the route
 * preflight rejects non-eligible models), so `willRunHarness` false there is
 * moot; keep the model check anyway so this helper stands alone.
 */
export function shouldEnableCloudSkillTools(args: {
  isGuest: boolean;
  harness: string | undefined;
  modelId: string;
  provider?: string;
  hasProjectId: boolean;
}): boolean {
  const willRunHarness =
    args.harness !== undefined &&
    isMCPJamProvidedModel(args.modelId, args.provider);
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

    listSkillFiles: tool({
      description:
        "List a skill's supporting files (scripts, references, assets). Use after loadSkill when a skill mentions supporting files.",
      inputSchema: z.object({
        name: z.string().describe("The skill name."),
      }),
      execute: async ({ name }) => {
        if (!NAME_RE.test(name)) {
          return `Error: Invalid skill name format "${name}".`;
        }
        try {
          const skill = await getCloudSkillByName(ctx, name);
          if (!skill) return `Error: Skill "${name}" not found.`;
          const files = await listCloudSkillFiles(ctx, skill.skillId);
          if (files.length === 0) {
            return `Skill "${name}" has no supporting files.`;
          }
          return (
            `Supporting files for "${name}":\n\n` +
            files.map((f) => `- ${f.path} (${f.size} bytes)`).join("\n") +
            `\n\nUse \`readSkillFile\` to read one.`
          );
        } catch (err) {
          return `Error listing files for "${name}": ${errMessage(err)}`;
        }
      },
    }),

    readSkillFile: tool({
      description:
        "Read the contents of a skill's supporting file by its relative path (e.g., 'scripts/fill.py').",
      inputSchema: z.object({
        name: z.string().describe("The skill name."),
        path: z
          .string()
          .describe("Relative path within the skill (e.g., 'scripts/fill.py')."),
      }),
      execute: async ({ name, path }) => {
        if (!NAME_RE.test(name)) {
          return `Error: Invalid skill name format "${name}".`;
        }
        try {
          const skill = await getCloudSkillByName(ctx, name);
          if (!skill) return `Error: Skill "${name}" not found.`;
          const file = await readCloudSkillFile(ctx, skill.skillId, path);
          if (!file.isText) {
            return `File "${path}" is binary (${file.mimeType}, ${file.size} bytes) and can't be shown as text.`;
          }
          return `# ${path}\n\n${file.content ?? ""}`;
        } catch (err) {
          return `Error reading "${path}" from "${name}": ${errMessage(err)}`;
        }
      },
    }),
  };
}

// Base section (listSkills + loadSkill) — advertised by every skill path.
const SKILLS_PROMPT_BASE =
  `\n\n## Skills\n\n` +
  `This project may have skills available to you (personal + shared) — reusable ` +
  `instruction packages for specific tasks. Call the \`listSkills\` tool to see ` +
  `what's available, then \`loadSkill\` to load a skill's full instructions when ` +
  `a task matches its purpose.`;
// File-tools sentence — only for paths that ALSO expose listSkillFiles/readSkillFile
// (the live cloud path). Pinned eval skills are supporting-file-free by design
// (decision 8c), so the pinned path omits this to avoid advertising absent tools.
const SKILLS_FILE_TOOLS_SENTENCE =
  ` If a loaded skill references supporting files, use \`listSkillFiles\` and ` +
  `\`readSkillFile\` to access them.`;
const CLOUD_SKILLS_PROMPT_SECTION =
  SKILLS_PROMPT_BASE + SKILLS_FILE_TOOLS_SENTENCE;

/**
 * Cloud equivalent of `getSkillToolsAndPrompt`. Always returns the tools +
 * prompt section; whether to advertise them is decided by the caller via
 * `shouldEnableCloudSkillTools` (non-guest + a project + not a real harness turn
 * — cloud skills need NO computer). Discovery is lazy via `listSkills` (a cheap
 * Convex read).
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

/**
 * PINNED skill tools for eval runs — an in-memory closure over frozen skill
 * content (from `configSnapshot.pinnedSkills`). Structurally identical to the
 * live cloud tools (same tool NAMES, NAME_RE, error strings, prompt section) so
 * the model behaves the same and the matcher's skill exemption still applies —
 * but `execute()` does ZERO network I/O (a mid-run skill edit can't change
 * behavior between iterations, which is the whole point of pinning). Never
 * `needsApproval` — pure reads of frozen content under an auto-deny eval run.
 */
export function createPinnedSkillTools(skills: PinnableSkill[]) {
  const byName = new Map(skills.map((s) => [s.name, s]));
  return {
    listSkills: tool({
      description:
        "List the skills available to you in this project (personal + shared). Returns each skill's name and description. Call this first to discover what's available, then `loadSkill` to load one.",
      inputSchema: z.object({}),
      execute: async () => {
        if (skills.length === 0) {
          return "No skills are available in this project.";
        }
        return (
          `Available skills:\n\n` +
          skills.map((s) => `- **${s.name}**: ${s.description}`).join("\n")
        );
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
        const skill = byName.get(name);
        if (!skill) return `Error: Skill "${name}" not found.`;
        return `# Skill: ${skill.name}\n\n${skill.content}`;
      },
    }),
  };
}

/**
 * Pinned equivalent of `getCloudSkillToolsAndPrompt`. Returns the frozen tools +
 * the SAME prompt section as live (so the model sees an identical skills stanza).
 */
export function getPinnedSkillToolsAndPrompt(skills: PinnableSkill[]): {
  tools: ReturnType<typeof createPinnedSkillTools>;
  systemPromptSection: string;
} {
  return {
    tools: createPinnedSkillTools(skills),
    // Pinned skills have no supporting files (decision 8c blocks file-backed
    // skills from eval selection), so the pinned tool set omits the file tools —
    // and the prompt omits the file-tools sentence to match (no absent-tool ask).
    systemPromptSection: SKILLS_PROMPT_BASE,
  };
}
