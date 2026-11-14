/**
 * The project's Convex skills for hosted/`/web` chat. Reads them from Convex
 * (`cloud-skills.ts`), NOT the Computer filesystem, so listing/loading never
 * wakes a sandbox.
 *
 * `listCloudRuntimeSkills` returns them as standalone skills for a turn's
 * `EffectiveCapabilitySet`; its tools (`effective-skill-tools.ts`) list the
 * catalog in the prompt and fetch a body or file only when the model asks.
 * `shouldEnableCloudSkillTools` decides which turns get them.
 */
import { isHostedCatalogModel } from "../../services/hosted-model-catalog.js";
import { runsHarness } from "../harness/harness-availability.js";
import type { RequestedModelSelection } from "@mcpjam/sdk/browser";
import type { RuntimeStandaloneSkill } from "../../services/environments/effective-capabilities.js";
import {
  CloudSkillsError,
  getCloudSkillByName,
  listCloudSkills,
  listCloudSkillFiles,
  readCloudSkillFile,
  type CloudSkillsContext,
} from "./cloud-skills.js";

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
