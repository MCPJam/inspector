/**
 * Which skills a turn's engine receives, decided in one place.
 *
 * `resolveTurnSkills` takes where a turn's skills come from and the engine that
 * runs it, and returns the plan: the skills as one set, what that engine is
 * handed, and every other skill with the reason it is left out. MCPJam's agent
 * builds its skill tools from the plan (`prepareChatV2`), and an eval turn
 * records `skillsAtTurn` from it.
 *
 * The plan states what the code does, so it is computed with the calls the
 * engines make: the skill list MCPJam's agent puts in its prompt, under the same
 * budget, and on a harness the adapter's `prepareSkills` over the copies the
 * harness turn writes to its box.
 *
 * A delivery that fails while the turn runs is not part of the plan. It belongs
 * on the turn's result ({@link TurnSkillsResult}), so a preview of the plan
 * never has to guess it.
 */
import type { PaneSkillReason } from "../../../shared/pane-skills-preview.js";
import { effectiveHarnessId } from "../../../shared/harness-descriptors.js";
import type {
  PinnableSkill,
  PinnedSkillArtifact,
} from "../../../shared/skill-types.js";
import { pinnedCatalogOmissions } from "../../utils/computers/cloud-skill-tools.js";
import { skillCatalogOmissions } from "../../utils/computers/effective-skill-tools.js";
import { pinnedArtifactsToRuntimeSkills } from "../../utils/harness/pinned-harness-skills.js";
import {
  getHarnessAdapter,
  harnessSupportsSkills,
} from "../../utils/harness/registry.js";
import {
  pinnedSkillId,
  pinnedSkillMeta,
  runNeedsEffectiveSkillSurface,
  type RunPinnedSkill,
} from "../evals/run-plugin-snapshot.js";
import {
  allEffectiveSkills,
  buildLiveEffectiveCapabilities,
  type EffectiveCapabilitySet,
} from "./effective-capabilities.js";

/**
 * Why an engine is not handed a skill: the Compare preview's reasons, plus
 * `omitted-from-catalog` (MCPJam's agent left it out of the prompt's skill list
 * to stay within the model's budget, so the model never learns it exists) and
 * `over-cap` (a stated cap on a turn's skills left it out; none applies today).
 */
export type SkillExclusionReason =
  | PaneSkillReason
  | "over-cap"
  | "omitted-from-catalog";

/** The engine that runs a turn. */
export type TurnRuntime =
  | { kind: "agent" }
  | { kind: "harness"; harnessId: string };

/** One skill a plan names. */
export interface SkillRef {
  /** Its row: a Library or plugin skill, a captured server skill, or a
   *  stand-in for an older pin that carries none. */
  skillId: string;
  /** How MCPJam's agent addresses it: a bare name, `<plugin>/<skill>` or
   *  `<server>/<skill>`. */
  ref: string;
  /** Its declared name, which a harness uses as its folder on the box. */
  name: string;
  /** The backend's metadata row for it, which `skillsAtTurn` stores. Absent
   *  when the source carries none. */
  provenance?: Record<string, unknown>;
}

export interface SkillExclusion {
  ref: SkillRef;
  reason: SkillExclusionReason;
}

/**
 * How MCP-server skills reach the engine on this turn. `box-files` is the
 * plain-file copy a harness gets in a pinned run.
 */
export type ServerSkillsVia =
  | "agent-tools"
  | "harness-tools"
  | "box-files"
  | "none";

/**
 * How MCPJam's agent serves the plan, as its skill tools behave today:
 *  - `frozen`: a run's pinned skills, addressed by ref. The approval switch
 *    does not apply: they are content frozen at run start, and an eval run
 *    denies every approval. A captured server skill's load still asks on its
 *    own (`effective-skill-tools.ts`), which an eval denies.
 *  - `frozen-names`: the same for runs pinned before plugins, through the
 *    bare-name `loadSkill` over `skills`, with no file tools.
 *  - `environment`: an environment's skills, by ref. Loads follow the switch,
 *    so a person watching their own turn gets the prompt they configured.
 *  - `live`: the skills a person has right now, by ref, under the switch, plus
 *    the connected servers' own skills, listed when the prompt is built. Only
 *    a live set adds those: an environment's server skills were captured with
 *    it, and fetching more would make the set stop describing the turn.
 */
export type AgentSkillTools =
  | { kind: "frozen" }
  | { kind: "frozen-names"; skills: PinnableSkill[] }
  | { kind: "environment" }
  | { kind: "live" };

/** One turn's skills, planned for the engine that runs it. */
export interface TurnSkills {
  runtime: TurnRuntime;
  /** The source's skills as one capability set. */
  set: EffectiveCapabilitySet;
  /** What the engine is handed. */
  delivered: SkillRef[];
  /** What it is not handed, and why. */
  excluded: SkillExclusion[];
  serverSkillsVia: ServerSkillsVia;
  /** How MCPJam's agent serves the plan; null when it gets no skill tools, as
   *  on a harness turn, whose box gets the skills. */
  agent: AgentSkillTools | null;
}

/** What happened to a plan once its turn ran. A skill that failed to arrive is
 *  recorded here, never in the plan. */
export interface TurnSkillsResult {
  delivered: SkillRef[];
  failed: Array<{ ref: SkillRef; error: string }>;
}

/**
 * A run's frozen skills, prepared once before its first model call
 * (`buildPinnedSkillSource`).
 */
export interface PinnedSkillSource {
  kind: "pins";
  /** The pins, content joined, in pin order. */
  pins: readonly RunPinnedSkill[];
  /** The pins as one capability set (`buildRunCapabilitySet`). */
  set: EffectiveCapabilitySet;
  /** The copies a harness writes to its box, file bodies inline: one per pin,
   *  in pin order. */
  harnessSkills: readonly PinnedSkillArtifact[];
}

export interface TurnSkillsInput {
  /**
   * `none`: the turn gets no skills from MCPJam. A harness turn handed no
   * frozen skills still fetches the project's own (`selectHarnessSkillSource`),
   * which a plan made here cannot see.
   */
  source: PinnedSkillSource | { kind: "none" };
  runtime: TurnRuntime;
  /** The model's context window in tokens, which sizes the skill list MCPJam's
   *  agent puts in its prompt. */
  modelContextTokens?: number;
}

/** The engine a client config runs on: its agent loop, else its harness
 *  (`effectiveHarnessId`), else MCPJam's agent. */
export function turnRuntime(
  config:
    | { agentLoop?: string | null; harness?: string | null }
    | null
    | undefined,
): TurnRuntime {
  const harnessId = effectiveHarnessId(config);
  return harnessId ? { kind: "harness", harnessId } : { kind: "agent" };
}

export function resolveTurnSkills({
  source,
  runtime,
  modelContextTokens,
}: TurnSkillsInput): TurnSkills {
  if (source.kind === "none" || source.pins.length === 0) {
    return {
      runtime,
      set:
        source.kind === "pins"
          ? source.set
          : buildLiveEffectiveCapabilities({}),
      delivered: [],
      excluded: [],
      serverSkillsVia: "none",
      agent: null,
    };
  }
  const listedAs = refsBySkillId(source.set);
  const refs = source.pins.map((pin): SkillRef => {
    const skillId = pinnedSkillId(pin);
    const provenance = pinnedSkillMeta(pin);
    return {
      skillId,
      ref: listedAs.get(skillId) ?? pin.modelRef ?? pin.name,
      name: pin.name,
      ...(provenance ? { provenance } : {}),
    };
  });
  if (runtime.kind === "harness") return planBox(runtime, source, refs);
  // Decided by what the run pinned, so every turn of a run gets one surface.
  return runNeedsEffectiveSkillSurface(source.pins)
    ? planAgentSet(source.set, refs, { kind: "frozen" }, modelContextTokens)
    : planNames(source.set, [...source.pins], refs, modelContextTokens);
}

/**
 * The `skillsAtTurn` rows for a planned turn: the metadata row of every skill
 * its engine is handed. A skill whose source carries no row is left out, as a
 * chat turn leaves out one the backend sent none for.
 */
export function toSkillsAtTurn(
  skills: TurnSkills,
): Array<Record<string, unknown>> {
  return skills.delivered.flatMap((ref) =>
    ref.provenance ? [ref.provenance] : [],
  );
}

/** A skill source as swarms and the chat surfaces build it until they plan
 *  with `resolveTurnSkills`. */
export type LegacySkillsSource =
  | { kind: "pinned"; skills: PinnableSkill[] }
  | {
      kind: "resolved";
      capabilities: EffectiveCapabilitySet;
      composeLiveServerSkills?: boolean;
    }
  | { kind: "none" };

/**
 * The plan for MCPJam's agent from a surface's own skill source, for a surface
 * that does not plan with `resolveTurnSkills` yet. `undefined` is a live turn
 * with no skills of its own, which still gets the connected servers' skills;
 * `none` gets no plan, because the turn gets no skills.
 *
 * The surface built its set itself, so a skill that set already dropped is in
 * neither list.
 */
export function turnSkillsFromLegacySource(
  source: LegacySkillsSource | undefined,
  modelContextTokens?: number,
): TurnSkills | undefined {
  if (source?.kind === "none") return undefined;
  if (source?.kind === "pinned") {
    const standaloneSkills = source.skills.map((skill) => ({
      skillId: `pin:${skill.name}`,
      ref: skill.name,
      name: skill.name,
      description: skill.description,
      content: skill.content,
      aggregateHash: skill.contentHash,
      files: [],
      channels: [],
    }));
    return planNames(
      buildLiveEffectiveCapabilities({ standaloneSkills }),
      source.skills,
      standaloneSkills.map(({ skillId, ref, name }) => ({
        skillId,
        ref,
        name,
      })),
      modelContextTokens,
    );
  }
  const set = source?.capabilities ?? buildLiveEffectiveCapabilities({});
  const live = source === undefined || source.composeLiveServerSkills === true;
  return planAgentSet(
    set,
    allEffectiveSkills(set).map(({ skillId, ref, name }) => ({
      skillId,
      ref,
      name,
    })),
    { kind: live ? "live" : "environment" },
    modelContextTokens,
  );
}

/** MCPJam's agent's ref-addressed tools over `set`. */
function planAgentSet(
  set: EffectiveCapabilitySet,
  refs: SkillRef[],
  agent: AgentSkillTools,
  modelContextTokens: number | undefined,
): TurnSkills {
  const listedAs = refsBySkillId(set);
  const omitted = new Set(skillCatalogOmissions(set, modelContextTokens));
  return {
    runtime: { kind: "agent" },
    set,
    ...partition(refs, (ref) => {
      const setRef = listedAs.get(ref.skillId);
      // Left out of the set: another skill already holds its ref.
      if (setRef === undefined) return "name-collision";
      return omitted.has(setRef) ? "omitted-from-catalog" : null;
    }),
    serverSkillsVia: "agent-tools",
    agent,
  };
}

/** The bare-name tools, which list and load `skills` by name. A server skill
 *  pin always takes the ref-addressed tools, so none arrives here. */
function planNames(
  set: EffectiveCapabilitySet,
  skills: PinnableSkill[],
  refs: SkillRef[],
  modelContextTokens: number | undefined,
): TurnSkills {
  const omitted = new Set(pinnedCatalogOmissions(skills, modelContextTokens));
  return {
    runtime: { kind: "agent" },
    set,
    ...partition(refs, (ref) =>
      omitted.has(ref.name) ? "omitted-from-catalog" : null,
    ),
    serverSkillsVia: "none",
    agent: { kind: "frozen-names", skills },
  };
}

/**
 * A harness writes the run's copies to its box: the ones its adapter's
 * `prepareSkills` keeps, from the list the harness turn builds in its pinned
 * mode. A captured server skill among them lands as a plain skill folder.
 */
function planBox(
  runtime: { kind: "harness"; harnessId: string },
  source: PinnedSkillSource,
  refs: SkillRef[],
): TurnSkills {
  const plan = { runtime, set: source.set, agent: null };
  if (!harnessSupportsSkills(runtime.harnessId)) {
    return {
      ...plan,
      ...partition(refs, () => "unsupported-harness"),
      serverSkillsVia: "none",
    };
  }
  const copies = pinnedArtifactsToRuntimeSkills([...source.harnessSkills]);
  const prepared = getHarnessAdapter(runtime.harnessId).prepareSkills(copies);
  const kept = new Set(prepared.delivered);
  const skipped = new Set(prepared.skipped.map((skill) => skill.name));
  return {
    ...plan,
    ...partition(refs, (ref, index) => {
      const copy = copies[index];
      if (copy && kept.has(copy)) return null;
      return skipped.has(ref.name) ? "invalid-skill-name" : "name-collision";
    }),
    serverSkillsVia: "box-files",
  };
}

function partition(
  refs: SkillRef[],
  reasonFor: (ref: SkillRef, index: number) => SkillExclusionReason | null,
): Pick<TurnSkills, "delivered" | "excluded"> {
  const delivered: SkillRef[] = [];
  const excluded: SkillExclusion[] = [];
  refs.forEach((ref, index) => {
    const reason = reasonFor(ref, index);
    if (reason) excluded.push({ ref, reason });
    else delivered.push(ref);
  });
  return { delivered, excluded };
}

function refsBySkillId(set: EffectiveCapabilitySet): Map<string, string> {
  return new Map(
    allEffectiveSkills(set).map((skill) => [skill.skillId, skill.ref]),
  );
}
