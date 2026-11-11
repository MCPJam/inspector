/**
 * A live turn's skill sources, made ready for the engine rules in
 * `turn-skills.ts`: a resolved environment, or a client with no environment.
 * Each becomes one capability set, a ref for every skill it names, and the
 * copies a harness turn would hand its box writer; `boxVerdicts` says which of
 * them the writer delivers, for a run's pins as well.
 *
 * A Playground client's own skills arrive inside its environment: the backend
 * resolves the client's selection, all visible by default, into the spec's
 * skills (`skillScope: 'visible'`). Nothing here reads a project's pool beside
 * an environment.
 */
import type { PinnedSkillArtifact } from "../../../shared/skill-types.js";
import { planBoxSkills } from "../../utils/harness/box-skills-writer.js";
import {
  getHarnessAdapter,
  harnessSupportsSkills,
} from "../../utils/harness/registry.js";
import type { RuntimeSkill } from "../../utils/harness/runtime-skills.js";
import { pinnedArtifactsToRuntimeSkills } from "../../utils/harness/skill-delivery.js";
import {
  allEffectiveSkills,
  buildLiveEffectiveCapabilities,
  resolveEffectiveCapabilities,
  withLocalSkills,
  type EffectiveCapabilityInput,
  type EffectiveCapabilitySet,
  type RuntimeLocalSkill,
  type RuntimeStandaloneSkill,
} from "./effective-capabilities.js";
import type { PluginRuntimeAttribution } from "./plugin-attribution.js";
import { runtimeSkills, type ResolvedEnvironmentSkill } from "./runtime.js";
import type {
  AgentSkillTools,
  ServerSkillsVia,
  SkillExclusion,
  SkillExclusionReason,
  SkillRef,
} from "./turn-skills.js";

/** What a client's turn reads at turn time, beside its environment. */
export interface LiveSkillExtras {
  /**
   * This machine's skills, in the local app. MCPJam's agent alone is handed
   * them: a harness running here reads the machine's skill folders itself.
   */
  localSkills?: readonly RuntimeLocalSkill[];
}

/** A resolved environment (`resolveEnvironmentForRuntime`). */
export interface EnvironmentSkillSource {
  kind: "environment";
  /** The environment after this turn's own plugin narrowing. */
  spec: EffectiveCapabilityInput;
  /** Plugin origins for its skills (`fetchPluginRuntimeAttribution`). */
  attribution: PluginRuntimeAttribution | null;
  /** Skills this turn's plugin narrowing switched off. */
  pluginDisabled?: readonly ResolvedEnvironmentSkill[];
  /**
   * Plans an eval run of the environment, which freezes its skills at start
   * and hands them over as pins: a harness then gets each captured MCP-server
   * skill on its box as a plain skill folder, which a live turn leaves off.
   * A run plans its own turns from its pins; this previews one.
   */
  frozen?: boolean;
  /**
   * Present, even empty, on a client's turn: its servers are connected now,
   * so their own skills join when the prompt is built. A named environment's
   * turn has none, since its server skills were captured with it, and a run's
   * frozen skills take nothing live.
   */
  liveExtras?: LiveSkillExtras;
}

/** A client turn with no environment behind it. */
export interface LiveSkillSource {
  kind: "live";
  /** The project's skills as the caller sees them now, personal ones
   *  included; none for a turn outside a project. */
  projectSkills: readonly RuntimeStandaloneSkill[];
  liveExtras?: LiveSkillExtras;
}

/** What a harness turn writes to its box. */
export interface BoxInput {
  /** The list the box writer plans from (`planBoxSkills`). */
  copies: readonly RuntimeSkill[];
  /** For each ref, in ref order: its copy, or why the turn writes none. */
  copyOf: ReadonlyArray<RuntimeSkill | SkillExclusionReason>;
  /** How captured MCP-server skills travel when the harness takes skills. */
  serverSkillsVia: ServerSkillsVia;
}

export interface SourcePlan {
  set: EffectiveCapabilitySet;
  /** Every skill the source names, once each, in source order. */
  refs: SkillRef[];
  /** This machine's skills, which MCPJam's agent is handed after `refs`. */
  agentOnly: SkillRef[];
  /** How MCPJam's agent would serve the set. */
  agent: AgentSkillTools;
  box: BoxInput;
  /** Left out whichever engine runs the turn. */
  disabled: SkillExclusion[];
}

export function sourcePlan(
  source: EnvironmentSkillSource | LiveSkillSource,
): SourcePlan {
  const environment = source.kind === "environment" ? source : undefined;
  const frozen = environment?.frozen === true;
  const pool = source.kind === "live" ? source.projectSkills : [];
  const local = frozen ? [] : (source.liveExtras?.localSkills ?? []);
  const set = environment
    ? withLocalSkills(
        resolveEffectiveCapabilities(environment.spec, environment.attribution),
        local,
      )
    : buildLiveEffectiveCapabilities({
        standaloneSkills: [...pool],
        localSkills: [...local],
      });
  const listedAs = new Map(
    allEffectiveSkills(set).map((skill) => [skill.skillId, skill.ref]),
  );
  const pluginRef = (skillId: string) =>
    environment?.attribution?.skillOrigins.get(skillId)?.modelRef;
  const refOf = (
    skill: {
      skillId: string;
      name: string;
      provenance?: Record<string, unknown>;
    },
    ref = skill.name,
  ): SkillRef => ({
    skillId: skill.skillId,
    ref: listedAs.get(skill.skillId) ?? pluginRef(skill.skillId) ?? ref,
    name: skill.name,
    ...(skill.provenance ? { provenance: skill.provenance } : {}),
  });

  const disabled = (environment?.pluginDisabled ?? []).map(
    (skill): SkillExclusion => ({
      ref: refOf(skill),
      reason: "plugin-disabled",
    }),
  );
  const seen = new Set(disabled.map(({ ref }) => ref.skillId));
  const refs: SkillRef[] = [];
  const copyOf: Array<RuntimeSkill | SkillExclusionReason> = [];
  const add = (ref: SkillRef, copy: RuntimeSkill | SkillExclusionReason) => {
    if (seen.has(ref.skillId)) return;
    seen.add(ref.skillId);
    refs.push(ref);
    copyOf.push(copy);
  };

  const ownCopies = environment ? runtimeSkills(environment.spec) : [];
  (environment?.spec.skills ?? []).forEach((skill, index) =>
    add(refOf(skill), ownCopies[index]!),
  );
  const serverCopies: RuntimeSkill[] = [];
  for (const skill of environment?.spec.serverSkills ?? []) {
    const ref = refOf(
      {
        skillId: skill.serverSkillId,
        name: skill.name,
        provenance: skill.provenance,
      },
      skill.ref,
    );
    if (!frozen) {
      add(ref, "server-skill-unsupported");
      continue;
    }
    // A pinned run writes a captured skill under its plain name.
    const copy = {
      skillId: skill.serverSkillId,
      name: skill.name,
      description: skill.description,
      content: skill.content,
      aggregateHash: skill.versionHash,
    };
    serverCopies.push(copy);
    add(ref, copy);
  }
  const poolCopies = pool.map((skill): RuntimeSkill => ({
    skillId: skill.skillId,
    name: skill.name,
    description: skill.description,
    // An adapter keeps or skips a copy by its name, so a pool read without
    // bodies, as MCPJam's agent reads it, plans the same.
    content: typeof skill.content === "string" ? skill.content : "",
    aggregateHash: skill.aggregateHash,
  }));
  pool.forEach((skill, index) => add(refOf(skill), poolCopies[index]!));
  // This machine's skills have no copy for a box.
  const agentOnly = local.flatMap((skill) => {
    if (seen.has(skill.skillId)) return [];
    seen.add(skill.skillId);
    return [refOf(skill, skill.ref)];
  });

  return {
    set,
    refs,
    agentOnly,
    // A client's turn is live even beside an environment: its servers are
    // connected now, so their own skills join when the prompt is built.
    agent: {
      kind: frozen
        ? "frozen"
        : environment && !environment.liveExtras
          ? "environment"
          : "live",
    },
    box: {
      copies: environment ? [...ownCopies, ...serverCopies] : poolCopies,
      copyOf,
      serverSkillsVia: frozen ? "box-files" : "none",
    },
    disabled,
  };
}

/**
 * A run's copies, one per pin, as its harness turn writes them in its pinned
 * mode. A captured server skill among them lands as a plain skill folder.
 */
export function pinnedBox(
  harnessSkills: readonly PinnedSkillArtifact[],
): BoxInput {
  const copies = pinnedArtifactsToRuntimeSkills([...harnessSkills]);
  return { copies, copyOf: copies, serverSkillsVia: "box-files" };
}

/**
 * What the box writer makes of a harness's box: for each ref, null when the
 * writer's plan delivers its copy, else why the box lacks it. A harness with
 * no skill channel takes none.
 */
export function boxVerdicts(
  harnessId: string,
  box: BoxInput,
): {
  reasonFor: (ref: SkillRef, index: number) => SkillExclusionReason | null;
  serverSkillsVia: ServerSkillsVia;
} {
  if (!harnessSupportsSkills(harnessId)) {
    return { reasonFor: () => "unsupported-harness", serverSkillsVia: "none" };
  }
  const descriptor = getHarnessAdapter(harnessId).skills;
  const plan = planBoxSkills(descriptor, box.copies);
  const kept = new Set(plan.deliver);
  const skipped = new Map(
    plan.skipped.map(({ skill, reason }) => [skill, reason]),
  );
  return {
    reasonFor: (_ref, index) => {
      const copy = box.copyOf[index];
      if (typeof copy === "string") return copy;
      if (copy && kept.has(copy)) return null;
      return (copy && skipped.get(copy)) ?? "name-collision";
    },
    serverSkillsVia:
      box.serverSkillsVia === "box-files"
        ? descriptor.serverSkills
        : box.serverSkillsVia,
  };
}
