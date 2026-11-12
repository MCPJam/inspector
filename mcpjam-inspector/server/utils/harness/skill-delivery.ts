/**
 * Which skill set a harness turn delivers — one decision, made here.
 *
 * Several callers can each be authoritative about a turn's skills, and they are
 * NOT interchangeable, so the precedence is written down once here instead of
 * being re-derived inside `runHarnessTurn`:
 *
 *   1. `pinned` — eval / swarm runs supply frozen `PinnedSkillArtifact`s from a
 *      run snapshot. Reproducibility outranks everything: a pinned run must be
 *      byte-identical on re-execution, so nothing live may be consulted.
 *   2. `environment` — a chat turn supplies the skills its environment
 *      resolved to, in ONE atomic read: a Playground client's selection, all
 *      visible by default, arrives inside that environment. The next turn
 *      re-resolves, but this one's answer is authoritative for it.
 *   3. `live` — the project-wide fetch, only when neither of the above spoke:
 *      a study whose scenario predates environments, or a swarm target that
 *      pinned nothing.
 *
 * PRESENCE, not length, selects a source in both overriding cases. An EMPTY
 * environment override is a real answer ("this environment delivers no skills")
 * and must skip the project-wide fetch: falling through would silently deliver
 * the whole project pool to a turn whose environment deliberately pinned none.
 *
 * `harnessTurnSkills` reads the chosen source into what the box writer
 * (`box-skills-writer.ts`) takes: the skills in the turn's order, their
 * supporting files, and the fingerprint that forks a resumable session.
 */
import type { EffectiveCapabilitySet } from "../../services/environments/effective-capabilities.js";
import type { PinnedSkillArtifact } from "../../../shared/skill-types.js";
import type {
  CloudSkillRuntimeItem,
  SkillExtraFrontmatterInput,
} from "../computers/convex-skills-client.js";
import type { BoxSkillFiles } from "./box-skills-writer.js";
import { capabilitySkillFiles } from "./plugin-delivery.js";
import {
  skillsFingerprint,
  type FetchRuntimeSkillFilesResult,
  type FetchRuntimeSkillsResult,
  type RuntimeSkill,
} from "./runtime-skills.js";

export type HarnessSkillSource =
  | { mode: "pinned"; skills: RuntimeSkill[] }
  | { mode: "environment"; skills: RuntimeSkill[] }
  | { mode: "live" };

export function selectHarnessSkillSource(args: {
  /** Frozen run artifacts (eval / swarm). */
  pinnedHarnessSkills?: PinnedSkillArtifact[];
  /** The skills this turn's environment resolved to. */
  runtimeSkillsOverride?: RuntimeSkill[];
}): HarnessSkillSource {
  if (args.pinnedHarnessSkills !== undefined) {
    return {
      mode: "pinned",
      skills: pinnedArtifactsToRuntimeSkills(args.pinnedHarnessSkills),
    };
  }
  if (args.runtimeSkillsOverride !== undefined) {
    return { mode: "environment", skills: args.runtimeSkillsOverride };
  }
  return { mode: "live" };
}

/** A turn's skills for its box, read from the source that spoke. */
export interface HarnessTurnSkills {
  mode: HarnessSkillSource["mode"];
  /** In the turn's order; `null` when the project's skills could not be read,
   *  which leaves the box exactly as it is. */
  skills: RuntimeSkill[] | null;
  /** Folded into the session lane so a skill change forks the session;
   *  `undefined` when the skills are unknown, so the stored hash stands. */
  skillsHash: string | undefined;
  /** The skills' supporting files, read when the writer needs them. */
  readFiles(): Promise<BoxSkillFiles>;
  /** A live turn: its servers are connected now, so their own skills may be
   *  offered. A client's environment (`liveTurn`) or the project's pool;
   *  never a run's copies or a named environment, which captured its own. */
  live: boolean;
}

const NO_FILES_KNOWN: BoxSkillFiles = { files: [], complete: () => false };

/**
 * Read a turn's skills from its source (`selectHarnessSkillSource`). Files come
 * from the same place as the skills: a run's frozen copies carry theirs, an
 * environment's capability set carries its skills' (the only source of a
 * plugin skill's, which the project-wide file query leaves out), and the
 * project's pool is read with the project-wide query, at write time and only
 * when the box gets a skill.
 */
export async function harnessTurnSkills(args: {
  pinnedHarnessSkills?: PinnedSkillArtifact[];
  runtimeSkillsOverride?: RuntimeSkill[];
  effectiveCapabilities?: EffectiveCapabilitySet;
  /** The environment override is a client's live turn, not a named
   *  environment's. */
  liveTurn?: boolean;
  /** The project's live skills and files; absent when the turn has no project
   *  to read, which delivers none from it. */
  project?: {
    skills(): Promise<FetchRuntimeSkillsResult>;
    files(): Promise<FetchRuntimeSkillFilesResult>;
  };
}): Promise<HarnessTurnSkills> {
  const source = selectHarnessSkillSource(args);
  const own = args.effectiveCapabilities
    ? capabilitySkillFiles(args.effectiveCapabilities)
    : undefined;
  const projectFiles = async (): Promise<BoxSkillFiles> => {
    const listing = await args.project?.files();
    return listing?.ok
      ? { files: listing.files, complete: () => true }
      : NO_FILES_KNOWN;
  };
  if (source.mode === "pinned" || source.mode === "environment") {
    const files =
      source.mode === "pinned"
        ? (args.pinnedHarnessSkills ?? []).flatMap((artifact, index) =>
            (artifact.files ?? []).map((file) => ({
              ...file,
              skillId: source.skills[index]!.skillId,
            })),
          )
        : own;
    return {
      mode: source.mode,
      skills: source.skills,
      skillsHash: skillsFingerprint(source.skills),
      readFiles: files
        ? async () => ({ files, complete: () => true })
        : projectFiles,
      live: source.mode === "environment" && args.liveTurn === true,
    };
  }
  const fetched = args.project
    ? await args.project.skills()
    : { ok: true as const, skills: [] };
  const live = fetched.ok ? fetched.skills : null;
  return {
    mode: "live",
    skills: live,
    skillsHash: live ? skillsFingerprint(live) : undefined,
    readFiles: projectFiles,
    live: true,
  };
}

/** Defensive projection of the artifact's preserved frontmatter onto the known
 * Agent-Skills envelope. Unknown keys are dropped (the backend re-validates on
 * pin; this only guards against a drifted wire shape). */
function toExtraFrontmatter(
  frontmatter: Record<string, unknown> | undefined
): SkillExtraFrontmatterInput | undefined {
  if (!frontmatter) return undefined;
  const out: SkillExtraFrontmatterInput = {};
  if (typeof frontmatter.license === "string")
    out.license = frontmatter.license;
  if (typeof frontmatter.compatibility === "string") {
    out.compatibility = frontmatter.compatibility;
  }
  const allowedTools =
    frontmatter["allowedTools"] ?? frontmatter["allowed-tools"];
  if (
    Array.isArray(allowedTools) &&
    allowedTools.every((t) => typeof t === "string")
  ) {
    out.allowedTools = allowedTools as string[];
  }
  const metadata = frontmatter.metadata;
  if (
    metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    Object.values(metadata).every((v) => typeof v === "string")
  ) {
    out.metadata = metadata as Record<string, string>;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Map pinned artifacts onto the runtime-skill shape the harness machinery
 * consumes. `aggregateHash` is the artifact's `contentHash` (the complete
 * pinned-envelope fingerprint), so `skillsFingerprint` over this list IS the
 * pinned-artifact fingerprint hash. `skillId` falls back to a content-derived
 * synthetic id when the pin lost its source skill pointer — it only needs to
 * be stable within the run for reconcile/fingerprint bookkeeping.
 */
export function pinnedArtifactsToRuntimeSkills(
  artifacts: PinnedSkillArtifact[]
): CloudSkillRuntimeItem[] {
  return artifacts.map((a) => ({
    skillId: a.skillId ?? `pinned:${a.contentHash}`,
    name: a.name,
    description: a.description,
    content: a.content,
    aggregateHash: a.contentHash,
    ...(toExtraFrontmatter(a.frontmatter)
      ? { extraFrontmatter: toExtraFrontmatter(a.frontmatter) }
      : {}),
  }));
}
