/**
 * Skill tools over an `EffectiveCapabilitySet` (INS-3).
 *
 * This is the EXPLICIT skill source: an in-memory closure over exactly the
 * skills one turn resolved, addressed by REF rather than by bare name.
 *
 * Why refs. `pluginSkillComponents.modelRef` namespaces a plugin skill as
 * `<plugin>/<skill>` precisely so two installed plugins may each declare
 * `summarize` without colliding in project-level skill identity. A bare-name
 * tool surface throws that away at the last step: the model would ask for
 * `summarize` and get whichever row we happened to index first. Every tool here
 * — `loadSkill`, `listSkillFiles`, `readSkillFile` — resolves through the same
 * ref, so a duplicate declared name cannot cross a plugin boundary.
 *
 * Bare names still work, and must: standalone project skills have no namespace,
 * and a model that read `summarize` in a prompt should be able to load it. A
 * bare name is accepted when it identifies exactly ONE skill in the set; when
 * it is ambiguous the tool refuses and names both refs rather than guessing.
 *
 * Supporting files come from the signed URLs the environment resolution already
 * minted in the SAME read as the skill body (see the backend's note on why a
 * separate `listSkillFilesForRuntime` call would let a body from one revision
 * pair with files from another). No extra network round-trip to Convex happens
 * here — only the `_storage` GET for a file the model actually asked for.
 *
 * Approval policy is the CALLER's: `prepareChatV2` wraps these with the host's
 * ordinary `requireToolApproval`. Plugin origin never bypasses approval.
 */
import { tool } from "ai";
import { z } from "zod";
import { getMimeType, isTextMimeType } from "../skill-parser.js";
import { logger } from "../logger.js";
import {
  MAX_SKILL_FILE_TEXT_BYTES,
  SKILL_FILE_MAX_READ_BYTES,
} from "./cloud-skills.js";
import {
  allEffectiveSkills,
  type EffectiveCapabilitySet,
  type RuntimePluginSkill,
  type RuntimeServerSkill,
  type RuntimeStandaloneSkill,
} from "../../services/environments/effective-capabilities.js";
import {
  applySkillMetadataBudget,
  skillMetadataBudgetChars,
} from "./skill-metadata-budget.js";

type EffectiveSkill =
  | RuntimePluginSkill
  | RuntimeStandaloneSkill
  | RuntimeServerSkill;

/** Bare standalone name, or a `<plugin>/<skill>` namespaced plugin ref. */
const REF_RE = /^[a-z0-9-]+(?:\/[a-z0-9-]+(?:~[a-f0-9]{8,64})?)?$/;

function pluginOf(skill: EffectiveSkill): RuntimePluginSkill["plugin"] {
  return (skill as RuntimePluginSkill).plugin;
}

function serverOf(skill: EffectiveSkill): RuntimeServerSkill | undefined {
  return "serverId" in skill ? skill : undefined;
}

/**
 * Human-readable provenance for the discovery listing.
 *
 * `isPlugin` is passed rather than inferred from `skill.plugin`, because a
 * plugin skill whose attribution failed has no `plugin` — labelling it
 * "project" would be a false claim about where the model's instructions came
 * from. It says "plugin" with the revision omitted instead.
 */
function originLabel(
  skill: EffectiveSkill,
  isPlugin: boolean,
  isServer: boolean
): string {
  if (isServer) {
    const server = serverOf(skill)!;
    return `MCP server ${server.serverLabel}@v${server.versionNumber}`;
  }
  if (!isPlugin) return "project";
  const plugin = pluginOf(skill);
  if (!plugin) return "plugin";
  // A short bundle-hash prefix, not the full hash: enough to tell two revisions
  // apart in a listing without spending the budget on 64 chars.
  const revision = plugin.bundleHash ? `@${plugin.bundleHash.slice(0, 8)}` : "";
  return `plugin ${plugin.name}${revision}`;
}

interface SkillLookup {
  byRef: Map<string, EffectiveSkill>;
  /** Bare name → every ref carrying it. Length > 1 ⇒ ambiguous. */
  refsByName: Map<string, string[]>;
}

function buildLookup(skills: EffectiveSkill[]): SkillLookup {
  const byRef = new Map<string, EffectiveSkill>();
  const refsByName = new Map<string, string[]>();
  for (const skill of skills) {
    byRef.set(skill.ref, skill);
    const refs = refsByName.get(skill.name) ?? [];
    refs.push(skill.ref);
    refsByName.set(skill.name, refs);
  }
  return { byRef, refsByName };
}

type Resolution =
  | { ok: true; skill: EffectiveSkill }
  | { ok: false; error: string };

/**
 * Resolve a model-supplied reference.
 *
 * Exact ref first, then the bare-name shortcut — and ONLY when unambiguous.
 * Refusing an ambiguous bare name is the point of the whole module: silently
 * picking one of two same-named plugin skills is the failure this replaces.
 */
function resolveRef(lookup: SkillLookup, raw: string): Resolution {
  if (!REF_RE.test(raw)) {
    return {
      ok: false,
      error: `Error: Invalid skill reference "${raw}". Use a skill name (e.g. 'pdf-processing') or a plugin reference (e.g. 'my-plugin/pdf-processing').`,
    };
  }
  const exact = lookup.byRef.get(raw);
  if (exact) return { ok: true, skill: exact };

  const refs = lookup.refsByName.get(raw);
  if (refs && refs.length === 1) {
    const skill = lookup.byRef.get(refs[0]);
    if (skill) return { ok: true, skill };
  }
  if (refs && refs.length > 1) {
    return {
      ok: false,
      error: `Error: "${raw}" is ambiguous — it matches ${refs
        .map((ref) => `"${ref}"`)
        .join(" and ")}. Use the full reference.`,
    };
  }
  return { ok: false, error: `Error: Skill "${raw}" not found.` };
}

function findFile(
  skill: EffectiveSkill,
  path: string
): { path: string; size: number; url: string | null } | undefined {
  return skill.files.find((file) => file.path === path);
}

/**
 * Build the discovery listing under the metadata budget, plus the refs that had
 * to be dropped. Computed ONCE at tool-construction time so every `listSkills`
 * call in a turn describes the same set (and so omissions are traced once).
 */
function buildListing(
  skills: EffectiveSkill[],
  pluginRefs: Set<string>,
  serverRefs: Set<string>,
  modelContextTokens: number | undefined
): { text: string; omittedRefs: string[] } {
  if (skills.length === 0) {
    return { text: "No skills are available for this turn.", omittedRefs: [] };
  }
  const budgetChars = skillMetadataBudgetChars(modelContextTokens);
  const { entries, omittedRefs } = applySkillMetadataBudget(
    skills.map((skill) => ({
      ref: skill.ref,
      description: skill.description,
      origin: originLabel(
        skill,
        pluginRefs.has(skill.ref),
        serverRefs.has(skill.ref)
      ),
    })),
    budgetChars
  );

  const lines = entries.map(
    (entry) => `- **${entry.ref}** (${entry.origin}): ${entry.description}`
  );
  // Absence is semantic: say that skills were dropped rather than presenting a
  // short list as if it were the whole set. This notice is deliberately emitted
  // OUTSIDE the budget — it exists precisely to report that the budget bit, so
  // suppressing it to fit would hide the omission it announces.
  const notice =
    omittedRefs.length > 0
      ? `\n\n(${omittedRefs.length} more skill${
          omittedRefs.length === 1 ? "" : "s"
        } could not be listed within this model's skill-metadata budget.)`
      : "";
  return {
    text: `Available skills:\n\n${lines.join("\n")}${notice}`,
    omittedRefs,
  };
}

export function createEffectiveSkillTools(args: {
  skills: EffectiveSkill[];
  /** Refs that came through the PLUGIN channel — see {@link originLabel}. */
  pluginRefs: Set<string>;
  /** Refs captured from MCP servers, which always require approval to load. */
  serverRefs: Set<string>;
  modelContextTokens?: number;
  signal?: AbortSignal;
}) {
  const lookup = buildLookup(args.skills);
  const listing = buildListing(
    args.skills,
    args.pluginRefs,
    args.serverRefs,
    args.modelContextTokens
  );
  if (listing.omittedRefs.length > 0) {
    logger.warn(
      "[effective-skills] skill metadata budget exceeded; skills omitted from discovery",
      {
        omitted: listing.omittedRefs,
        total: args.skills.length,
      }
    );
  }

  return {
    listSkills: tool({
      description:
        "List the skills available to you for this turn. Returns each skill's reference, origin, and description. Call this first, then `loadSkill` with the reference.",
      inputSchema: z.object({}),
      execute: async () => listing.text,
    }),

    loadSkill: {
      ...tool({
        description:
          "Load a skill's full instructions by reference. Use when a task matches a skill's purpose.",
        inputSchema: z.object({
          name: z
            .string()
            .describe(
              "The skill reference from `listSkills` — a bare name ('pdf-processing') or a plugin reference ('my-plugin/pdf-processing')."
            ),
        }),
        execute: async ({ name }) => {
          const resolved = resolveRef(lookup, name);
          if (!resolved.ok) return resolved.error;
          const { skill } = resolved;
          return `# Skill: ${skill.ref}\n\n${skill.content}`;
        },
      }),
      needsApproval: ({ name }: { name: string }) => {
        const resolved = resolveRef(lookup, name);
        return resolved.ok && args.serverRefs.has(resolved.skill.ref);
      },
    },

    listSkillFiles: tool({
      description:
        "List a skill's supporting files (scripts, references, assets). Use after `loadSkill` when a skill mentions supporting files.",
      inputSchema: z.object({
        name: z.string().describe("The skill reference."),
      }),
      execute: async ({ name }) => {
        const resolved = resolveRef(lookup, name);
        if (!resolved.ok) return resolved.error;
        const { skill } = resolved;
        if (skill.files.length === 0) {
          return `Skill "${skill.ref}" has no supporting files.`;
        }
        return (
          `Supporting files for "${skill.ref}":\n\n` +
          skill.files.map((f) => `- ${f.path} (${f.size} bytes)`).join("\n") +
          `\n\nUse \`readSkillFile\` to read one.`
        );
      },
    }),

    readSkillFile: {
      ...tool({
        description:
          "Read the contents of a skill's supporting file by its relative path (e.g., 'scripts/fill.py').",
        inputSchema: z.object({
          name: z.string().describe("The skill reference."),
          path: z
            .string()
            .describe(
              "Relative path within the skill (e.g., 'scripts/fill.py')."
            ),
        }),
        execute: async ({ name, path }) => {
          const resolved = resolveRef(lookup, name);
          if (!resolved.ok) return resolved.error;
          const { skill } = resolved;
          const file = findFile(skill, path);
          if (!file) {
            return `Error: "${path}" is not a supporting file of "${skill.ref}".`;
          }
          if (!file.url) {
            return `Error: "${path}" could not be read (no download URL was issued for it).`;
          }
          // Guard on the SERVER-verified size before fetching, mirroring
          // `readCloudSkillFile` — a large blob must not be buffered to discover
          // it was too large.
          if (file.size > SKILL_FILE_MAX_READ_BYTES) {
            return `Error: "${path}" is too large to read (${file.size} bytes).`;
          }
          try {
            const timeout = AbortSignal.timeout(30_000);
            const signal = args.signal
              ? AbortSignal.any([args.signal, timeout])
              : timeout;
            const res = await fetch(file.url, { signal });
            if (!res.ok) {
              return `Error reading "${path}" from "${skill.ref}" (${res.status}).`;
            }
            const bytes = new Uint8Array(await res.arrayBuffer());
            const mimeType = getMimeType(path);
            if (
              !isTextMimeType(mimeType) ||
              bytes.byteLength > MAX_SKILL_FILE_TEXT_BYTES
            ) {
              return `File "${path}" is binary (${mimeType}, ${bytes.byteLength} bytes) and can't be shown as text.`;
            }
            return `# ${path}\n\n${new TextDecoder().decode(bytes)}`;
          } catch (error) {
            return `Error reading "${path}" from "${skill.ref}": ${
              error instanceof Error ? error.message : "Unknown error"
            }`;
          }
        },
      }),
      needsApproval: ({ name }: { name: string }) => {
        const resolved = resolveRef(lookup, name);
        return resolved.ok && args.serverRefs.has(resolved.skill.ref);
      },
    },
  };
}

const EFFECTIVE_SKILLS_PROMPT_BASE =
  `\n\n## Skills\n\n` +
  `This turn has a fixed set of skills — reusable instruction packages for ` +
  `specific tasks. Call the \`listSkills\` tool to see them, then \`loadSkill\` ` +
  `with a skill's reference to load its full instructions when a task matches. ` +
  `A reference is either a bare name or \`<plugin>/<skill>\` for a skill a ` +
  `plugin provides; always pass the reference exactly as \`listSkills\` returned it.`;

const EFFECTIVE_SKILLS_FILE_TOOLS_SENTENCE =
  ` If a loaded skill references supporting files, use \`listSkillFiles\` and ` +
  `\`readSkillFile\` with the same reference to access them.`;

/**
 * Tools + prompt section for a turn driven by an `EffectiveCapabilitySet`.
 *
 * The file-tools sentence is advertised only when the set actually contains a
 * file-bearing skill: promising tools for files that do not exist invites the
 * model to go looking for them.
 */
export function getEffectiveSkillToolsAndPrompt(
  capabilities: EffectiveCapabilitySet,
  options?: { modelContextTokens?: number; signal?: AbortSignal }
): {
  tools: ReturnType<typeof createEffectiveSkillTools>;
  systemPromptSection: string;
} {
  const skills = allEffectiveSkills(capabilities);
  const hasFiles = skills.some((skill) => skill.files.length > 0);
  return {
    tools: createEffectiveSkillTools({
      skills,
      pluginRefs: new Set(capabilities.pluginSkills.map((skill) => skill.ref)),
      serverRefs: new Set(capabilities.serverSkills.map((skill) => skill.ref)),
      ...(options?.modelContextTokens !== undefined
        ? { modelContextTokens: options.modelContextTokens }
        : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
    }),
    systemPromptSection:
      EFFECTIVE_SKILLS_PROMPT_BASE +
      (hasFiles ? EFFECTIVE_SKILLS_FILE_TOOLS_SENTENCE : ""),
  };
}
