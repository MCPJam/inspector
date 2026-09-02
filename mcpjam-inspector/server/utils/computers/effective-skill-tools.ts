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
 * ref, so a duplicate declared name cannot cross a plugin boundary. The
 * discovery catalog is inlined in the system prompt (budgeted, with overflow
 * notice); there is no `listSkills` tool. Zero skills → no tools, no stanza.
 *
 * Emulated `loadSkill` is an approximation: real Claude Code/Codex read an
 * installed SKILL.md from the filesystem with no model-callable load tool.
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
  type RuntimeLocalSkill,
  type RuntimePluginSkill,
  type RuntimeServerSkill,
  type RuntimeSkillFile,
  type RuntimeStandaloneSkill,
} from "../../services/environments/effective-capabilities.js";
import {
  formatSkillCatalogBody,
  renderBudgetedSkillCatalog,
  skillMetadataBudgetChars,
} from "./skill-metadata-budget.js";

type EffectiveSkill =
  | RuntimePluginSkill
  | RuntimeStandaloneSkill
  | RuntimeServerSkill
  | RuntimeLocalSkill;

/**
 * The body, whether it was carried inline or has to be fetched.
 *
 * A captured set holds the bytes; a live one holds a thunk, so a project with
 * 200 skills costs one fetch for the skill the model actually loads rather than
 * 200 for a catalog it mostly ignores.
 */
async function readContent(skill: EffectiveSkill): Promise<string> {
  return typeof skill.content === "string"
    ? skill.content
    : await skill.content();
}

/**
 * The supporting-file list, fetched at most ONCE per tool set if the origin is
 * lazy.
 *
 * `listSkillFiles` then `readSkillFile` is the normal sequence, and an uncached
 * loader fetches the same listing for both — including the empty case, where
 * the second call buys nothing at all. The PROMISE is cached, not the result,
 * so two concurrent calls share one fetch; a rejected one is evicted so a
 * transient failure does not pin the skill file-less for the rest of the turn.
 */
function makeFileReader(): (
  skill: EffectiveSkill,
) => Promise<RuntimeSkillFile[]> {
  const listings = new Map<EffectiveSkill, Promise<RuntimeSkillFile[]>>();
  return (skill) => {
    if (skill.files.length > 0 || !skill.listFiles) {
      return Promise.resolve(skill.files);
    }
    const cached = listings.get(skill);
    if (cached) return cached;
    const pending = skill.listFiles().catch((error: unknown) => {
      listings.delete(skill);
      throw error;
    });
    listings.set(skill, pending);
    return pending;
  };
}

/** Bare standalone name, or a `<plugin>/<skill>` namespaced plugin ref. */
const REF_RE = /^[a-z0-9-]+(?:\/[a-z0-9-]+(?:~[a-f0-9]{8,64})?)?$/;

function pluginOf(skill: EffectiveSkill): RuntimePluginSkill["plugin"] {
  return (skill as RuntimePluginSkill).plugin;
}

function serverOf(skill: EffectiveSkill): RuntimeServerSkill | undefined {
  return "serverId" in skill ? skill : undefined;
}

function localOf(skill: EffectiveSkill): RuntimeLocalSkill | undefined {
  return "directory" in skill ? (skill as RuntimeLocalSkill) : undefined;
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
  isServer: boolean,
): string {
  const local = localOf(skill);
  // Named with its directory, because "which code-review is this?" is exactly
  // the question a merged catalog raises and the answer is where it lives.
  if (local) return `local ${local.directory}`;
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
  { ok: true; skill: EffectiveSkill } | { ok: false; error: string };

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

/**
 * Build the inlined discovery listing under the metadata budget, plus the
 * refs that had to be dropped. Computed ONCE at prompt-build time so the
 * stanza and the overflow warn describe the same set.
 */
function buildListing(
  skills: EffectiveSkill[],
  pluginRefs: Set<string>,
  serverRefs: Set<string>,
  modelContextTokens: number | undefined,
): { text: string; omittedRefs: string[] } {
  const budgetChars = skillMetadataBudgetChars(modelContextTokens);
  const { lines, omittedRefs } = renderBudgetedSkillCatalog(
    skills.map((skill) => ({
      ref: skill.ref,
      description: skill.description,
      origin: originLabel(
        skill,
        pluginRefs.has(skill.ref),
        serverRefs.has(skill.ref),
      ),
    })),
    budgetChars,
  );
  return {
    text: formatSkillCatalogBody(lines, omittedRefs),
    omittedRefs,
  };
}

export function createEffectiveSkillTools(args: {
  skills: EffectiveSkill[];
  /** Refs that came through the PLUGIN channel — see {@link originLabel}. */
  pluginRefs: Set<string>;
  /** Refs captured from MCP servers, which always require approval to load. */
  serverRefs: Set<string>;
  signal?: AbortSignal;
}) {
  const lookup = buildLookup(args.skills);
  const readFiles = makeFileReader();

  return {
    loadSkill: {
      ...tool({
        description:
          "Load a skill's full instructions by reference. Use when a task matches a skill's purpose.",
        inputSchema: z.object({
          name: z
            .string()
            .describe(
              "The skill reference from the skills list above — a bare name ('pdf-processing') or a plugin reference ('my-plugin/pdf-processing').",
            ),
        }),
        execute: async ({ name }) => {
          const resolved = resolveRef(lookup, name);
          if (!resolved.ok) return resolved.error;
          const { skill } = resolved;
          try {
            return `# Skill: ${skill.ref}\n\n${await readContent(skill)}`;
          } catch (error) {
            return `Error loading "${skill.ref}": ${
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
        let files: RuntimeSkillFile[];
        try {
          files = await readFiles(skill);
        } catch (error) {
          return `Error listing files for "${skill.ref}": ${
            error instanceof Error ? error.message : "Unknown error"
          }`;
        }
        if (files.length === 0) {
          return `Skill "${skill.ref}" has no supporting files.`;
        }
        return (
          `Supporting files for "${skill.ref}":\n\n` +
          files.map((f) => `- ${f.path} (${f.size} bytes)`).join("\n") +
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
              "Relative path within the skill (e.g., 'scripts/fill.py').",
            ),
        }),
        execute: async ({ name, path }) => {
          const resolved = resolveRef(lookup, name);
          if (!resolved.ok) return resolved.error;
          const { skill } = resolved;
          let files: RuntimeSkillFile[];
          try {
            files = await readFiles(skill);
          } catch (error) {
            return `Error reading "${path}" from "${skill.ref}": ${
              error instanceof Error ? error.message : "Unknown error"
            }`;
          }
          const file = files.find((entry) => entry.path === path);
          if (!file) {
            return `Error: "${path}" is not a supporting file of "${skill.ref}".`;
          }
          // Guard on the SERVER-verified size before fetching, mirroring
          // `readCloudSkillFile` — a large blob must not be buffered to discover
          // it was too large.
          if (file.size > SKILL_FILE_MAX_READ_BYTES) {
            return `Error: "${path}" is too large to read (${file.size} bytes).`;
          }
          try {
            let bytes: Uint8Array;
            if (file.read) {
              // A local file has no URL to sign — it is on this machine's disk.
              bytes = await file.read();
            } else if (file.url) {
              const timeout = AbortSignal.timeout(30_000);
              const signal = args.signal
                ? AbortSignal.any([args.signal, timeout])
                : timeout;
              const res = await fetch(file.url, { signal });
              if (!res.ok) {
                return `Error reading "${path}" from "${skill.ref}" (${res.status}).`;
              }
              bytes = new Uint8Array(await res.arrayBuffer());
            } else {
              return `Error: "${path}" could not be read (no download URL was issued for it).`;
            }
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

const EFFECTIVE_SKILLS_TRIGGER =
  `You have access to the following skills. When the user names a skill ` +
  `or a task clearly matches one's purpose, load it with \`loadSkill\` ` +
  `before acting. A reference is either a bare name or \`<plugin>/<skill>\` ` +
  `for a skill a plugin provides; always pass the reference exactly as ` +
  `listed below.`;

const EFFECTIVE_SKILLS_FILE_TOOLS_SENTENCE =
  `If a loaded skill references supporting files, use \`listSkillFiles\` and ` +
  `\`readSkillFile\` with the same reference to access them.`;

/**
 * Tools + prompt section for a turn driven by an `EffectiveCapabilitySet`.
 *
 * Empty capability set → no tools, no stanza. The already-built listing
 * (budgeted, with overflow notice) is inlined in the prompt. The file-tools
 * sentence is advertised only when the set actually contains a file-bearing
 * skill: promising tools for files that do not exist invites the model to go
 * looking for them.
 */
export function getEffectiveSkillToolsAndPrompt(
  capabilities: EffectiveCapabilitySet,
  options?: { modelContextTokens?: number; signal?: AbortSignal },
): {
  tools: Partial<ReturnType<typeof createEffectiveSkillTools>>;
  systemPromptSection: string;
} {
  const skills = allEffectiveSkills(capabilities);
  if (skills.length === 0) {
    return { tools: {}, systemPromptSection: "" };
  }
  const pluginRefs = new Set(
    capabilities.pluginSkills.map((skill) => skill.ref),
  );
  const serverRefs = new Set(
    capabilities.serverSkills.map((skill) => skill.ref),
  );
  const listing = buildListing(
    skills,
    pluginRefs,
    serverRefs,
    options?.modelContextTokens,
  );
  if (listing.omittedRefs.length > 0) {
    logger.warn(
      "[effective-skills] skill metadata budget exceeded; skills omitted from prompt catalog",
      {
        omitted: listing.omittedRefs,
        total: skills.length,
      },
    );
  }
  // A lazy origin has not listed its files yet, so `files.length` cannot
  // answer this. Advertising on the possibility is the right way round:
  // withholding the tools would hide files that do exist, while offering
  // them for a skill with none costs one refusal the model can read.
  const hasFiles = skills.some(
    (skill) => skill.files.length > 0 || skill.listFiles !== undefined,
  );
  const parts = ["## Skills", "", EFFECTIVE_SKILLS_TRIGGER, "", listing.text];
  if (hasFiles) {
    parts.push("", EFFECTIVE_SKILLS_FILE_TOOLS_SENTENCE);
  }
  return {
    tools: createEffectiveSkillTools({
      skills,
      pluginRefs,
      serverRefs,
      ...(options?.signal ? { signal: options.signal } : {}),
    }),
    systemPromptSection: `\n\n${parts.join("\n")}`,
  };
}
