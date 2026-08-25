/**
 * Cloud skill tools for the AI SDK — hosted/`/web` chat. Reads the project's
 * durable skills from Convex (`cloud-skills.ts`), NOT the Computer filesystem,
 * so listing/loading never wakes a sandbox.
 *
 * Catalog in the prompt, load on demand: names + one-line descriptions are
 * inlined at prompt-build time (sorted + budgeted); `loadSkill` delivers the
 * full body. This matches the local-FS path and real Claude Code. Zero skills
 * → no tools, no stanza. `listSkills` is not advertised here — it remains
 * only on the SEP-2640 wrapper for MCP-server-provided skills.
 *
 * Emulated `loadSkill` is an approximation: real Claude Code/Codex read an
 * installed SKILL.md from the filesystem with no model-callable load tool
 * (the harness adapters already mirror that). When the tools are wired is
 * decided by `shouldEnableCloudSkillTools` (see `web/chat-v2.ts`).
 */
import { tool } from "ai";
import { z } from "zod";
import { isHostedCatalogModel } from "../../services/hosted-model-catalog.js";
import type { ExecutionScope } from "../execution-scope.js";
import type { PinnableSkill } from "../../../shared/skill-types.js";
import { logger } from "../logger.js";
import {
  CloudSkillsError,
  getCloudSkillBodyForActor,
  listCloudSkillsForActor,
  listCloudSkillFilesForActor,
  readCloudSkillFileForActor,
  type CloudSkillsContext,
} from "./cloud-skills.js";
import {
  formatSkillCatalogBody,
  renderBudgetedSkillCatalog,
  skillMetadataBudgetChars,
} from "./skill-metadata-budget.js";

const NAME_RE = /^[a-z0-9-]+$/;

/**
 * ConvexHttpClient.query takes no AbortSignal, so the prompt-build fetch
 * races this timeout and proceeds without skills on expiry.
 */
export const CLOUD_SKILLS_FETCH_TIMEOUT_MS = 3_000;

/**
 * Distinguishes a failed catalog fetch from a genuine empty project.
 * Threaded onto `prepareChatV2` so callers/traces can record it.
 */
export type SkillsFetchFailure = {
  errorClass: string;
  status?: number;
  message: string;
  latencyMs: number;
};

/**
 * Whether the emulated chat path should advertise the cloud skill tools.
 *
 * Cloud skills are a Convex-backed PROJECT resource (no computer required), so
 * any signed-in member with a project gets them — EXCEPT when the turn will run
 * a real harness runtime, which delivers skills via the adapter `skills` param
 * (or, for skills-incapable runtimes like Codex, not at all) — advertising the
 * emulated tools there would be a prompt/tool mismatch.
 *
 * Guests (COMP-38): a plain share-link/chatbox guest still gets no skill tools,
 * but a guest whose turn carries a Phase-3 `executionScope` does. That scope is
 * the ONLY channel by which a non-member's skill read is authorized — the
 * project-wide `projectSkills:listSkills` query requires membership, so the
 * scoped `listSkillsForRuntimeExecution` is what the reads go through (see
 * `cloud-skills.ts`) and the backend re-resolves the grant on every one of them.
 * Gating on the scope therefore gates on the same authority that will decide
 * whether the reads succeed, and a guest the backend declines gets an empty
 * catalog (`skillsFetchFailed`) rather than tools that error on every call.
 *
 * NOT gated on an attached `computer`: the backend omits that field for guest
 * actors (see `scenario-runtime-config.ts`), and guest `bash` comes either from
 * an out-of-band ephemeral sandbox binding or from a scope-authorized reserve —
 * so a computer probe here reads false exactly when a guest has a VM.
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
  /**
   * Does this turn carry a Phase-3 `executionScope` the skill reads can be
   * authorized against? Only consulted for a guest, who has no other
   * authorization channel — a member reads by membership.
   */
  hasExecutionScope: boolean;
  harness: string | undefined;
  modelId: string;
  provider?: string;
  hasProjectId: boolean;
}): boolean {
  const willRunHarness =
    args.harness !== undefined &&
    isHostedCatalogModel(args.modelId, args.provider);
  // A guest needs the scope grant their reads will be authorized against;
  // members already read the project-wide catalog by membership.
  const actorAllowed = !args.isGuest || args.hasExecutionScope;
  return actorAllowed && !willRunHarness && args.hasProjectId;
}

/**
 * The scope the cloud-skill READS should run under, or `undefined` for the
 * membership-authorized queries.
 *
 * ONE value for two decisions — the gate above and the read context — because
 * they must not be able to disagree. Deriving them separately let a config that
 * carries `executionScope: null` open the gate (`null !== undefined`) while the
 * reads fell back to the member query, which is precisely the guest-403 this
 * change exists to prevent.
 *
 * Returns undefined for a member: their runtime config carries a scope too, and
 * the scoped query is shared-only, so routing them through it would drop their
 * personal skills. No structural validation of the scope itself — it is opaque
 * and the backend re-resolves it (see `execution-scope.ts`); a malformed one is
 * rejected there and the turn degrades to no skills.
 */
export function resolveGuestCloudSkillScope(args: {
  isGuest: boolean;
  executionScope: ExecutionScope | null | undefined;
}): ExecutionScope | undefined {
  if (!args.isGuest) return undefined;
  return args.executionScope ?? undefined;
}

function errMessage(err: unknown): string {
  if (err instanceof CloudSkillsError) return err.message;
  return err instanceof Error ? err.message : "Unknown error";
}

function sortByName<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

function budgetedCatalogBody(
  entries: Array<{ name: string; description: string }>,
  modelContextTokens?: number
): { body: string; omittedRefs: string[] } {
  const budgetChars = skillMetadataBudgetChars(modelContextTokens);
  const { lines, omittedRefs } = renderBudgetedSkillCatalog(
    sortByName(entries).map((entry) => ({
      ref: entry.name,
      description: entry.description,
    })),
    budgetChars
  );
  return { body: formatSkillCatalogBody(lines, omittedRefs), omittedRefs };
}

/**
 * Strengthened trigger: when the user names a skill or a task clearly
 * matches one's purpose, load it before acting. Mirrors/upgrades the
 * local-FS wording in `skill-tools.ts`.
 */
const SKILLS_TRIGGER =
  `You have access to the following skills. When the user names a skill ` +
  `or a task clearly matches one's purpose, load it with \`loadSkill\` ` +
  `before acting.`;

// File-tools sentence — only for paths that ALSO expose listSkillFiles/readSkillFile
// (the live cloud path). The pinned surface serves only file-free pins
// (decision 8c), so it omits this to avoid advertising absent tools. A run
// whose pins DO carry files takes the ref-addressed surface instead
// (INS-5 — `skillsSource: pinned-effective`).
const SKILLS_FILE_TOOLS_SENTENCE =
  `After loading a skill, you can use \`listSkillFiles\` and \`readSkillFile\` ` +
  `to access any supporting files (scripts, references, assets) that the skill provides.`;

function buildSkillsPromptSection(args: {
  catalogBody: string;
  fileTools: boolean;
}): string {
  const parts = ["## Skills", "", SKILLS_TRIGGER, "", args.catalogBody];
  if (args.fileTools) {
    parts.push("", SKILLS_FILE_TOOLS_SENTENCE);
  }
  return `\n\n${parts.join("\n")}`;
}

export function createCloudSkillTools(ctx: CloudSkillsContext) {
  return {
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
          const skill = await getCloudSkillBodyForActor(ctx, name);
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
          const skill = await getCloudSkillBodyForActor(ctx, name);
          if (!skill) return `Error: Skill "${name}" not found.`;
          const files = await listCloudSkillFilesForActor(ctx, skill.skillId);
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
          .describe(
            "Relative path within the skill (e.g., 'scripts/fill.py')."
          ),
      }),
      execute: async ({ name, path }) => {
        if (!NAME_RE.test(name)) {
          return `Error: Invalid skill name format "${name}".`;
        }
        try {
          const skill = await getCloudSkillBodyForActor(ctx, name);
          if (!skill) return `Error: Skill "${name}" not found.`;
          const file = await readCloudSkillFileForActor(
            ctx,
            skill.skillId,
            path
          );
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

export type CloudSkillTools = ReturnType<typeof createCloudSkillTools>;
export type CloudSkillToolSet = Partial<CloudSkillTools>;

class CloudSkillsFetchTimeoutError extends CloudSkillsError {
  constructor() {
    super("Timed out fetching the skill catalog", 504);
    this.name = "CloudSkillsFetchTimeoutError";
  }
}

function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CloudSkillsFetchTimeoutError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function skillsFailureFrom(
  err: unknown,
  latencyMs: number
): SkillsFetchFailure {
  const errorClass = err instanceof Error ? err.constructor.name : typeof err;
  const status = err instanceof CloudSkillsError ? err.status : undefined;
  return {
    errorClass,
    ...(status !== undefined ? { status } : {}),
    message: errMessage(err),
    latencyMs,
  };
}

export type CloudSkillToolsAndPrompt = {
  tools: CloudSkillToolSet;
  systemPromptSection: string;
  skillsFetchFailed?: SkillsFetchFailure;
};

/**
 * Cloud equivalent of `getSkillToolsAndPrompt`. Fetches the catalog at
 * prompt-build time, inlines names+descriptions, and advertises `loadSkill`
 * (+ file tools). Failure or timeout → empty tools/stanza plus
 * `skillsFetchFailed` (distinguishable from a genuine empty project).
 * Zero skills → empty tools/stanza, no marker.
 */
export async function getCloudSkillToolsAndPrompt(
  ctx: CloudSkillsContext,
  options?: { modelContextTokens?: number }
): Promise<CloudSkillToolsAndPrompt> {
  const started = Date.now();
  try {
    const skills = await raceWithTimeout(
      listCloudSkillsForActor(ctx),
      CLOUD_SKILLS_FETCH_TIMEOUT_MS
    );
    const latencyMs = Date.now() - started;
    logger.info("[cloud-skills] catalog fetch", {
      latencyMs,
      skillCount: skills.length,
      projectId: ctx.projectId,
    });
    if (skills.length === 0) {
      return { tools: {}, systemPromptSection: "" };
    }
    const { body, omittedRefs } = budgetedCatalogBody(
      skills,
      options?.modelContextTokens
    );
    if (omittedRefs.length > 0) {
      logger.warn(
        "[cloud-skills] skill metadata budget exceeded; skills omitted from prompt catalog",
        { omitted: omittedRefs, total: skills.length }
      );
    }
    return {
      tools: createCloudSkillTools(ctx),
      systemPromptSection: buildSkillsPromptSection({
        catalogBody: body,
        fileTools: true,
      }),
    };
  } catch (err) {
    const skillsFetchFailed = skillsFailureFrom(err, Date.now() - started);
    logger.warn(
      "[cloud-skills] catalog fetch failed; skipping skill tools for this turn",
      {
        errorClass: skillsFetchFailed.errorClass,
        status: skillsFetchFailed.status,
        latencyMs: skillsFetchFailed.latencyMs,
        projectId: ctx.projectId,
        message: skillsFetchFailed.message,
      }
    );
    return {
      tools: {},
      systemPromptSection: "",
      skillsFetchFailed,
    };
  }
}

/**
 * PINNED skill tools for eval runs — an in-memory closure over frozen skill
 * content (from `configSnapshot.pinnedSkills`). Mirrors the live cloud
 * `loadSkill` tool (same NAME, NAME_RE, error strings) so the model behaves
 * the same and the matcher's skill exemption still applies — but `execute()`
 * does ZERO network I/O (a mid-run skill edit can't change behavior between
 * iterations, which is the whole point of pinning). The discovery catalog is
 * inlined in the prompt (sorted + budgeted), not a `listSkills` tool. The
 * supporting-file tools (`listSkillFiles`/`readSkillFile`) are intentionally
 * OMITTED: pinned eval skills reaching THIS surface are file-free (decision
 * 8c), and the pinned prompt omits the file-tools guidance to match. A run
 * whose pins carry supporting files or a plugin ref is routed to the
 * ref-addressed surface in `./effective-skill-tools.ts` instead (INS-5),
 * which can serve both. Never `needsApproval` — pure reads of frozen content
 * under an auto-deny eval run.
 *
 * Emulated `loadSkill` is an approximation of real Claude Code/Codex, which
 * read an installed SKILL.md with no model-callable load tool.
 */
export function createPinnedSkillTools(skills: PinnableSkill[]) {
  const byName = new Map(skills.map((s) => [s.name, s]));
  return {
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

export type PinnedSkillTools = ReturnType<typeof createPinnedSkillTools>;
export type PinnedSkillToolSet = Partial<PinnedSkillTools>;

/**
 * Pinned equivalent of `getCloudSkillToolsAndPrompt`. Inlines the frozen
 * names+descriptions (sorted + budgeted). Empty list → empty tools + empty
 * stanza (defensive — the runner already maps empty pins to `kind:"none"`).
 * Omits the file-tools sentence (decision 8c pins are file-free).
 */
export function getPinnedSkillToolsAndPrompt(
  skills: PinnableSkill[],
  options?: { modelContextTokens?: number }
): {
  tools: PinnedSkillToolSet;
  systemPromptSection: string;
} {
  if (skills.length === 0) {
    return { tools: {}, systemPromptSection: "" };
  }
  const { body, omittedRefs } = budgetedCatalogBody(
    skills,
    options?.modelContextTokens
  );
  if (omittedRefs.length > 0) {
    logger.warn(
      "[pinned-skills] skill metadata budget exceeded; skills omitted from prompt catalog",
      { omitted: omittedRefs, total: skills.length }
    );
  }
  return {
    tools: createPinnedSkillTools(skills),
    systemPromptSection: buildSkillsPromptSection({
      catalogBody: body,
      fileTools: false,
    }),
  };
}

// The Project-Environment turn used to reuse the pinned tools verbatim
// (`getResolvedSkillToolsAndPrompt`). INS-3 replaced that with
// `./effective-skill-tools.ts`, which addresses skills by REF rather than bare
// name so two plugins may declare the same skill name, and which exposes the
// supporting-file tools an environment turn genuinely can serve.
