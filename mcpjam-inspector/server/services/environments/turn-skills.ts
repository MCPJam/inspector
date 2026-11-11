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
 * budget, and on a harness the box writer's plan (`planBoxSkills`) over the
 * copies the harness turn writes to its box.
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
import {
  boxVerdicts,
  pinnedBox,
  sourcePlan,
  type BoxInput,
  type EnvironmentSkillSource,
  type LiveSkillSource,
} from "./turn-skill-sources.js";
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
 * `over-cap` (a stated cap on a turn's skills left it out; none applies today).
 */
export type SkillExclusionReason = PaneSkillReason | "over-cap";

/** The engine that runs a turn. */
export type TurnRuntime =
  { kind: "agent" } | { kind: "harness"; harnessId: string };

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
  /**
   * MCPJam's agent left it out of the skill list in its prompt to stay within
   * the model's budget. Its tools still load it by name or ref (a skill the
   * person names or picks with `/`), so it is delivered all the same.
   */
  omittedFromCatalog?: true;
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
  "agent-tools" | "harness-tools" | "box-files" | "none";

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
 *    the connected servers' own skills. Those join the set when the prompt is
 *    built, once the servers are connected (`withLiveServerSkills` in
 *    `prepareChatV2`), so they are not in this plan's `delivered`. They load
 *    under the switch, by ref or by skill URI. Only a live set adds them: an
 *    environment's server skills were captured with it, and fetching more
 *    would make the set stop describing the turn.
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
  /** What the engine is handed, including what it can load but is not listed
   *  in its prompt (`omittedFromCatalog`). A live plan's connected servers'
   *  skills are listed when its prompt is built, not here (`agent`). */
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
   * `none`: the turn gets no skills from MCPJam. The live sources, a resolved
   * environment and a client's own skills, are in `turn-skill-sources.ts`.
   */
  source:
    | PinnedSkillSource
    | EnvironmentSkillSource
    | LiveSkillSource
    | { kind: "none" };
  runtime: TurnRuntime;
  /** The model's context window in tokens, which sizes the skill list MCPJam's
   *  agent puts in its prompt. */
  modelContextTokens?: number;
}

/** The engine a client config runs on: its agent loop, else its harness
 *  (`effectiveHarnessId`), else MCPJam's agent. */
export function turnRuntime(
  config:
    { agentLoop?: string | null; harness?: string | null } | null | undefined,
): TurnRuntime {
  const harnessId = effectiveHarnessId(config);
  return harnessId ? { kind: "harness", harnessId } : { kind: "agent" };
}

export function resolveTurnSkills({
  source,
  runtime,
  modelContextTokens,
}: TurnSkillsInput): TurnSkills {
  if (source.kind === "environment" || source.kind === "live") {
    return planSource(source, runtime, modelContextTokens);
  }
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
  if (runtime.kind === "harness") {
    return planBox(runtime, source.set, refs, pinnedBox(source.harnessSkills));
  }
  // Decided by what the run pinned, so every turn of a run gets one surface.
  return runNeedsEffectiveSkillSurface(source.pins)
    ? planAgentSet(source.set, refs, { kind: "frozen" }, modelContextTokens)
    : planNames(source.set, [...source.pins], refs, modelContextTokens);
}

/** A resolved environment or a client's own skills, planned for the engine
 *  that runs the turn. A skill the turn switched off stays off on both. */
function planSource(
  source: EnvironmentSkillSource | LiveSkillSource,
  runtime: TurnRuntime,
  modelContextTokens: number | undefined,
): TurnSkills {
  const { set, refs, agentOnly, agent, box, disabled } = sourcePlan(source);
  const plan =
    runtime.kind === "harness"
      ? planBox(runtime, set, refs, box)
      : planAgentSet(set, [...refs, ...agentOnly], agent, modelContextTokens);
  return { ...plan, excluded: [...disabled, ...plan.excluded] };
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
  const inSet = new Set(refsBySkillId(set).keys());
  const omitted = new Set(skillCatalogOmissions(set, modelContextTokens));
  return {
    runtime: { kind: "agent" },
    set,
    ...partition(
      refs,
      // Left out of the set: another skill already holds its ref.
      (ref) => (inSet.has(ref.skillId) ? null : "name-collision"),
      (ref) => omitted.has(ref.ref),
    ),
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
    ...partition(
      refs,
      () => null,
      (ref) => omitted.has(ref.name),
    ),
    serverSkillsVia: "none",
    agent: { kind: "frozen-names", skills },
  };
}

/** A harness gets its skills on its box (`boxVerdicts`), never as tools. */
function planBox(
  runtime: { kind: "harness"; harnessId: string },
  set: EffectiveCapabilitySet,
  refs: SkillRef[],
  box: BoxInput,
): TurnSkills {
  const { reasonFor, serverSkillsVia } = boxVerdicts(runtime.harnessId, box);
  return {
    runtime,
    set,
    agent: null,
    ...partition(refs, reasonFor),
    serverSkillsVia,
  };
}

/** Splits refs into delivered and excluded; `unlisted` marks a delivered
 *  skill the prompt's skill list leaves out. */
function partition(
  refs: SkillRef[],
  reasonFor: (ref: SkillRef, index: number) => SkillExclusionReason | null,
  unlisted: (ref: SkillRef) => boolean = () => false,
): Pick<TurnSkills, "delivered" | "excluded"> {
  const delivered: SkillRef[] = [];
  const excluded: SkillExclusion[] = [];
  refs.forEach((ref, index) => {
    const reason = reasonFor(ref, index);
    if (reason) excluded.push({ ref, reason });
    else
      delivered.push(
        unlisted(ref) ? { ...ref, omittedFromCatalog: true } : ref,
      );
  });
  return { delivered, excluded };
}

function refsBySkillId(set: EffectiveCapabilitySet): Map<string, string> {
  return new Map(
    allEffectiveSkills(set).map((skill) => [skill.skillId, skill.ref]),
  );
}
