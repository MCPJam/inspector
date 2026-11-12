/**
 * Cloud skill tools for the AI SDK — hosted/`/web` chat. Reads the project's
 * durable skills from Convex (`cloud-skills.ts`), NOT the Computer filesystem,
 * so listing/loading never wakes a sandbox.
 *
 * Catalog in the prompt, load on demand: names + one-line descriptions are
 * inlined at prompt-build time (sorted + budgeted); `loadSkill` delivers the
 * full body. This matches the local-FS path and real Claude Code. Zero skills
 * → no tools, no stanza. `listSkills` is not advertised here or anywhere
 * else.
 *
 * Emulated `loadSkill` is an approximation: real Claude Code/Codex read an
 * installed SKILL.md from the filesystem with no model-callable load tool
 * (the harness adapters already mirror that). When the tools are wired is
 * decided by `shouldEnableCloudSkillTools` (see `web/chat-v2.ts`).
 */
import { skillTool as tool } from "../skill-tool.js";
import { z } from "zod";
import { isHostedCatalogModel } from "../../services/hosted-model-catalog.js";
import { runsHarness } from "../harness/harness-availability.js";
import type { RequestedModelSelection } from "@mcpjam/sdk/browser";
import type { PinnableSkill } from "../../../shared/skill-types.js";
import type { RuntimeStandaloneSkill } from "../../services/environments/effective-capabilities.js";
import { logger } from "../logger.js";
import {
  CloudSkillsError,
  getCloudSkillByName,
  listCloudSkills,
  listCloudSkillFiles,
  readCloudSkillFile,
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
  /** The picker's own-provider stamp (`hosted: false` ⇒ not MCPJam's). */
  hosted?: boolean;
  /**
   * The turn's saved selection. A brokered harness on an org connection to its
   * own vendor runs the REAL runtime (on the organization's key), so it gets
   * the adapter's skills, not the emulated ones.
   */
  selection?: RequestedModelSelection;
  hasProjectId: boolean;
}): boolean {
  const willRunHarness =
    args.selection?.source === "org"
      ? runsHarness({
          harness: args.harness,
          model: {
            id: args.modelId,
            ...(args.provider !== undefined ? { provider: args.provider } : {}),
            ...(args.hosted !== undefined ? { hosted: args.hosted } : {}),
          },
          selection: args.selection,
        })
      : args.harness !== undefined &&
        isHostedCatalogModel(args.modelId, args.provider);
  return !args.isGuest && !willRunHarness && args.hasProjectId;
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

/** The names the bare-name skill list leaves out to stay within this model's
 *  budget, as `getPinnedSkillToolsAndPrompt` builds the list. */
export function pinnedCatalogOmissions(
  skills: PinnableSkill[],
  modelContextTokens?: number
): string[] {
  return budgetedCatalogBody(skills, modelContextTokens).omittedRefs;
}

/**
 * Strengthened trigger: when the user names a skill or a task clearly
 * matches one's purpose, load it before acting.
 */
const SKILLS_TRIGGER =
  `You have access to the following skills. When the user names a skill ` +
  `or a task clearly matches one's purpose, load it with \`loadSkill\` ` +
  `before acting.`;

function buildSkillsPromptSection(args: { catalogBody: string }): string {
  const parts = ["## Skills", "", SKILLS_TRIGGER, "", args.catalogBody];
  return `\n\n${parts.join("\n")}`;
}

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

export function skillsFailureFrom(
  err: unknown,
  latencyMs: number
): SkillsFetchFailure {
  const errorClass =
    err instanceof Error ? err.constructor.name : typeof err;
  const status = err instanceof CloudSkillsError ? err.status : undefined;
  return {
    errorClass,
    ...(status !== undefined ? { status } : {}),
    message: errMessage(err),
    latencyMs,
  };
}

/**
 * The project's Convex skills as one origin of an `EffectiveCapabilitySet`.
 *
 * The counterpart to `listLocalRuntimeSkills`, and what lets the merged catalog
 * carry project skills without the exclusive `cloudSkills` branch the chat
 * orchestrator used to take.
 *
 * Everything here stays LAZY: the catalog costs one query, and a body or a
 * file list is fetched only for the skill the model actually asks for.
 * Eager-loading a 200-skill project on every turn to build a listing the
 * model mostly ignores is the failure this shape avoids.
 *
 * Throws on catalog failure so the caller can distinguish it from a genuinely
 * empty project.
 */
export async function listCloudRuntimeSkills(
  ctx: CloudSkillsContext
): Promise<RuntimeStandaloneSkill[]> {
  const skills = await raceWithTimeout(
    listCloudSkills(ctx),
    CLOUD_SKILLS_FETCH_TIMEOUT_MS
  );
  return skills.map((skill) => ({
    skillId: skill.skillId,
    // A bare name, like any standalone project skill: this IS the project's
    // standalone family, reached live instead of through a resolved
    // environment. A local skill's `local/` prefix is what keeps the two
    // separable when both are present.
    ref: skill.name,
    name: skill.name,
    description: skill.description,
    aggregateHash: skill.aggregateHash,
    channels: [],
    content: async () => {
      const detail = await getCloudSkillByName(ctx, skill.name);
      if (!detail) {
        throw new Error(`Skill "${skill.name}" is no longer in this project.`);
      }
      return detail.content;
    },
    files: [],
    listFiles: async () => {
      const files = await listCloudSkillFiles(ctx, skill.skillId);
      return files.map((file) => ({
        path: file.path,
        size: file.size,
        // No URL is minted here: `readCloudSkillFile` resolves a fresh signed
        // one at read time. Minting per file per turn would spend a query on
        // every file the model never opens, and hand out URLs that outlive the
        // read they were for.
        url: null,
        read: async () => {
          const content = await readCloudSkillFile(
            ctx,
            skill.skillId,
            file.path
          );
          // Text and binary arrive on different fields; the caller re-applies
          // its own mime/size policy to whatever bytes come back, so both are
          // decoded here rather than judged.
          if (typeof content.content === "string") {
            return new TextEncoder().encode(content.content);
          }
          if (typeof content.base64 === "string") {
            return Uint8Array.from(Buffer.from(content.base64, "base64"));
          }
          return new Uint8Array(0);
        },
      }));
    },
  }));
}

/**
 * PINNED skill tools for eval runs — an in-memory closure over frozen skill
 * content (from `configSnapshot.pinnedSkills`). The tool is named `loadSkill`
 * so the matcher's skill exemption still applies — but `execute()`
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
 * The pinned tools plus a prompt stanza that inlines the frozen
 * names+descriptions (sorted + budgeted). Empty list → empty tools + empty
 * stanza (defensive — the runner already maps empty pins to `kind:"none"`).
 * Omits file-tools guidance (decision 8c pins are file-free).
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
    }),
  };
}

// The Project-Environment turn used to reuse the pinned tools verbatim
// (`getResolvedSkillToolsAndPrompt`). INS-3 replaced that with
// `./effective-skill-tools.ts`, which addresses skills by REF rather than bare
// name so two plugins may declare the same skill name, and which exposes the
// supporting-file tools an environment turn genuinely can serve.
