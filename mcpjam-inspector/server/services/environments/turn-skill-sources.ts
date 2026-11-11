/**
 * A live turn's skill sources, made ready for the engine rules in
 * `turn-skills.ts`: a resolved environment, or a client with no environment.
 * Each becomes one capability set, a ref for every skill it names, and the
 * copies a harness turn would hand its box writer; `boxVerdicts` says which of
 * them the writer delivers, and which captured MCP-server skills a harness
 * takes through MCPJam's skill tools instead, for a run's pins as well.
 */
import type { PinnedSkillArtifact } from "../../../shared/skill-types.js";
import { planBoxSkills } from "../../utils/harness/box-skills-writer.js";
import {
  getHarnessAdapter,
  harnessSupportsSkills,
} from "../../utils/harness/registry.js";
import type { RuntimeSkill } from "../../utils/harness/runtime-skills.js";
import { takesServerSkillsAsTools } from "../../utils/harness/skills-descriptor.js";
import {
  composeLivePlusSkills,
  pinnedArtifactsToRuntimeSkills,
} from "../../utils/harness/skill-delivery.js";
import {
  allEffectiveSkills,
  buildLiveEffectiveCapabilities,
  resolveEffectiveCapabilities,
  withLiveProjectSkills,
  type EffectiveCapabilityInput,
  type EffectiveCapabilitySet,
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

/** What a live turn reads at turn time, beside its environment. */
export interface LiveSkillExtras {
  /**
   * The project's skills as the caller sees them now, personal ones included:
   * a Playground client's pool, which its environment does not carry. Present
   * means the turn reads the pool, even when it is empty.
   */
  projectSkills?: readonly RuntimeStandaloneSkill[];
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
   * and hands them over as pins: a `box-files` harness then gets each
   * captured MCP-server skill on its box as a plain skill folder, which a
   * live turn leaves off.
   * A run plans its own turns from its pins; this previews one.
   */
  frozen?: boolean;
  /** Read by a live turn only; a run's frozen skills take nothing live. */
  liveExtras?: LiveSkillExtras;
}

/** A client turn with no environment behind it. */
export interface LiveSkillSource {
  kind: "live";
  liveExtras: LiveSkillExtras;
}

/**
 * A skill captured from an MCP server, which a harness takes through MCPJam's
 * skill tools or as a plain skill folder (`box-files`): its copy for that
 * folder, which only a frozen run writes, or null on a live turn.
 */
export interface ServerSkillEntry {
  serverSkillCopy: RuntimeSkill | null;
}

/** What a harness turn writes to its box. */
export interface BoxInput {
  /** The list the box writer plans from (`planBoxSkills`), server skills'
   *  plain copies included. */
  copies: readonly RuntimeSkill[];
  /** For each ref, in ref order: its copy, why the turn writes none, or that
   *  it is a captured server skill. */
  copyOf: ReadonlyArray<RuntimeSkill | SkillExclusionReason | ServerSkillEntry>;
  /** How captured MCP-server skills travel to a `box-files` harness. */
  serverSkillsVia: ServerSkillsVia;
}

export interface SourcePlan {
  set: EffectiveCapabilitySet;
  /** Every skill the source names, once each, in source order. */
  refs: SkillRef[];
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
  const pool = frozen ? undefined : source.liveExtras?.projectSkills;
  const live = buildLiveEffectiveCapabilities({
    standaloneSkills: [...(pool ?? [])],
  });
  const set = environment
    ? withLiveProjectSkills(
        resolveEffectiveCapabilities(environment.spec, environment.attribution),
        live,
      )
    : live;
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
  const copyOf: Array<BoxInput["copyOf"][number]> = [];
  const add = (ref: SkillRef, copy: BoxInput["copyOf"][number]) => {
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
      add(ref, { serverSkillCopy: null });
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
    add(ref, { serverSkillCopy: copy });
  }
  const poolCopies = (pool ?? []).map((skill): RuntimeSkill => ({
    skillId: skill.skillId,
    name: skill.name,
    description: skill.description,
    // An adapter keeps or skips a copy by its name, so a pool read without
    // bodies, as MCPJam's agent reads it, plans the same.
    content: typeof skill.content === "string" ? skill.content : "",
    aggregateHash: skill.aggregateHash,
  }));
  (pool ?? []).forEach((skill, index) => add(refOf(skill), poolCopies[index]!));
  // Only a client's turn merges its pool beside its environment by box
  // folder; with no environment, the adapter gets the pool as read.
  const copies = !environment
    ? poolCopies
    : pool
      ? (composeLivePlusSkills(poolCopies, ownCopies).skills ?? [])
      : [...ownCopies, ...serverCopies];

  return {
    set,
    refs,
    // A client's turn is live even beside an environment: its servers are
    // connected now, so their own skills join when the prompt is built.
    agent: {
      kind: frozen ? "frozen" : environment && !pool ? "environment" : "live",
    },
    box: { copies, copyOf, serverSkillsVia: frozen ? "box-files" : "none" },
    disabled,
  };
}

/**
 * A run's copies, one per pin, as its harness turn writes them in its pinned
 * mode. A captured server skill among them is a plain skill folder on a
 * `box-files` harness.
 */
export function pinnedBox(
  harnessSkills: readonly PinnedSkillArtifact[],
): BoxInput {
  const copies = pinnedArtifactsToRuntimeSkills([...harnessSkills]);
  return {
    copies,
    copyOf: copies.map((copy, index) =>
      harnessSkills[index]?.server ? { serverSkillCopy: copy } : copy,
    ),
    serverSkillsVia: "box-files",
  };
}

/**
 * What the box writer makes of a harness's box: for each ref, null when the
 * writer's plan delivers its copy, else why the box lacks it. A harness with
 * no skill channel takes none. One that takes server skills through MCPJam's
 * skill tools gets every captured one there, and none of them on its box.
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
  const adapter = getHarnessAdapter(harnessId);
  const viaTools = takesServerSkillsAsTools(adapter);
  const serverCopies = new Set(
    box.copyOf.flatMap((entry) =>
      isServerSkillEntry(entry) && entry.serverSkillCopy
        ? [entry.serverSkillCopy]
        : [],
    ),
  );
  const plan = planBoxSkills(
    adapter.skills,
    viaTools
      ? box.copies.filter((copy) => !serverCopies.has(copy))
      : box.copies,
  );
  const kept = new Set(plan.deliver);
  const skipped = new Map(
    plan.skipped.map(({ skill, reason }) => [skill, reason]),
  );
  return {
    reasonFor: (_ref, index) => {
      const entry = box.copyOf[index];
      if (isServerSkillEntry(entry) && viaTools) return null;
      // Otherwise a server skill is its plain copy, which a live turn lacks.
      const copy = isServerSkillEntry(entry)
        ? (entry.serverSkillCopy ?? "server-skill-unsupported")
        : entry;
      if (typeof copy === "string") return copy;
      if (copy && kept.has(copy)) return null;
      return (copy && skipped.get(copy)) ?? "name-collision";
    },
    serverSkillsVia: viaTools ? "harness-tools" : box.serverSkillsVia,
  };
}

function isServerSkillEntry(
  entry: BoxInput["copyOf"][number] | undefined,
): entry is ServerSkillEntry {
  return typeof entry === "object" && "serverSkillCopy" in entry;
}
