/**
 * Composition state shared by every surface that picks where a run executes
 * (Swarms journeys, Eval suites, User Testing scenarios).
 *
 * Two layers, and the relationship between them is the whole feature:
 *
 *  - `environmentIds` — SAVED project environments the user picked from the
 *    Environments list. Curated, named, reusable.
 *  - `stack` — the loose slots a saved environment is made of (clients, server
 *    group, pinned skills, sandbox image, and — on evals — the model axis),
 *    editable in place so "same setup, different client" costs one click
 *    instead of a trip to /environments.
 *
 * Selecting a saved environment SEEDS the stack from it; editing any slot flips
 * `customized`. That flag is what tells a surface it can no longer just hand
 * `environmentIds` to the backend and must resolve the stack into real
 * environment rows first.
 *
 * Model is a second fan-out axis (D1/D2): it desugars to ad-hoc environments,
 * one cell per (host × model-choice). Surfaces that do not opt the models
 * slot in keep today's one-axis compose.
 */
import type {
  ProjectEnvironmentSkillSelection,
  ProjectEnvironmentView,
} from "@/hooks/useProjectEnvironments";
import { isNamedEnvironment } from "@/lib/environment-label";

/**
 * Structured model axis (D2). Never auto-seed a host's default modelId as
 * an explicit pick — the fingerprint treats explicit-equals-default as a
 * distinct row.
 */
export type ModelSelection = {
  includeClientDefaults: boolean;
  explicitModelIds: string[];
};

export const DEFAULT_MODEL_SELECTION: ModelSelection = {
  includeClientDefaults: true,
  explicitModelIds: [],
};

export type EnvironmentStack = {
  /** Primary fan-out axis. Required for the compose (resolve) path. */
  hostIds: string[];
  /** Optional; null/empty = each client's own server picks. */
  serverAttachmentId: string | null;
  skillSelection: ProjectEnvironmentSkillSelection | null;
  computerEnvironmentId: string | null;
  /**
   * Model-choice axis. Default is "one inherit cell per client" — exactly
   * today's behavior. Explicit ids mint override cells.
   */
  modelSelection: ModelSelection;
};

export type EnvironmentComposerState = {
  /** Selected saved environment ids. Cap: the surface's `maxTargets`. */
  environmentIds: string[];
  stack: EnvironmentStack;
  /**
   * True once the user edits the stack after (or without) seeding from saved
   * environments. A pure saved-environment selection keeps this false and skips
   * resolution entirely.
   */
  customized: boolean;
};

export function emptyModelSelection(): ModelSelection {
  return { includeClientDefaults: true, explicitModelIds: [] };
}

export function emptyEnvironmentStack(): EnvironmentStack {
  return {
    hostIds: [],
    serverAttachmentId: null,
    skillSelection: null,
    computerEnvironmentId: null,
    modelSelection: emptyModelSelection(),
  };
}

export function emptyComposerState(): EnvironmentComposerState {
  return {
    environmentIds: [],
    stack: emptyEnvironmentStack(),
    customized: false,
  };
}

/**
 * Selection readers accept `undefined` and read it as the empty selection.
 *
 * A stack can genuinely arrive without one: state persisted before this slot
 * existed (a saved swarm draft) rehydrates into the current shape. Guarding
 * here rather than at each call site means a missed guard degrades to "client
 * defaults" instead of throwing while rendering the strip.
 */
export function modelChoiceCount(
  selection: ModelSelection | undefined,
): number {
  const resolved = selection ?? emptyModelSelection();
  return (
    (resolved.includeClientDefaults ? 1 : 0) + resolved.explicitModelIds.length
  );
}

/** Inherit first, then explicit ids in list order. Host-major mint uses this. */
export function expandModelChoices(
  selection: ModelSelection | undefined,
): Array<{
  modelId: string | undefined;
}> {
  const resolved = selection ?? emptyModelSelection();
  const choices: Array<{ modelId: string | undefined }> = [];
  if (resolved.includeClientDefaults) {
    choices.push({ modelId: undefined });
  }
  for (const modelId of resolved.explicitModelIds) {
    choices.push({ modelId });
  }
  return choices;
}

export function sameModelSelection(
  a: ModelSelection,
  b: ModelSelection,
): boolean {
  if (a.includeClientDefaults !== b.includeClientDefaults) return false;
  if (a.explicitModelIds.length !== b.explicitModelIds.length) return false;
  const left = [...a.explicitModelIds].sort();
  const right = [...b.explicitModelIds].sort();
  return left.every((id, i) => id === right[i]);
}

/**
 * One-shot default for a blank composer (e.g. New Swarm open).
 *
 * Prefers a named saved environment (previewed if still live, else first),
 * which fills client / server group / skills / computer from that row. With no
 * named environments — or when the environments flag is off — falls back to
 * compose mode on the previewed/first host plus the first server attachment.
 * Returns `null` when nothing can be seeded.
 */
export function defaultComposerState(args: {
  environments: ProjectEnvironmentView[];
  hosts: ReadonlyArray<{ hostId: string }>;
  preferredHostId?: string | null;
  preferredEnvironmentId?: string | null;
  serverAttachments: ReadonlyArray<{ _id: string }>;
  environmentsEnabled: boolean;
}): EnvironmentComposerState | null {
  const liveNamed = args.environments.filter(
    (env) => !env.archivedAt && isNamedEnvironment(env),
  );
  if (args.environmentsEnabled && liveNamed.length > 0) {
    const preferred =
      (args.preferredEnvironmentId
        ? liveNamed.find(
            (env) => env.environmentId === args.preferredEnvironmentId,
          )
        : undefined) ?? liveNamed[0];
    return composerStateFromEnvironments([preferred]);
  }

  if (args.hosts.length === 0) return null;
  const preferredHost =
    args.hosts.find((host) => host.hostId === args.preferredHostId) ??
    args.hosts[0];
  return {
    environmentIds: [],
    stack: {
      ...emptyEnvironmentStack(),
      hostIds: [preferredHost.hostId],
      serverAttachmentId: args.serverAttachments[0]?._id ?? null,
    },
    customized: true,
  };
}

/** The slots of a saved environment, as a loose stack the user can now edit. */
export function stackFromEnvironment(
  env: ProjectEnvironmentView,
): EnvironmentStack {
  return {
    hostIds: env.hostId ? [env.hostId] : [],
    serverAttachmentId: env.serverAttachmentId ?? null,
    skillSelection: env.skillSelection ?? null,
    computerEnvironmentId: env.computerEnvironmentId ?? null,
    modelSelection: {
      includeClientDefaults: !env.modelId,
      explicitModelIds: env.modelId ? [env.modelId] : [],
    },
  };
}

/**
 * Which shared slots this project actually runs. Mirrors the resolver's
 * `sharedFields`: a flag-disabled slot is dropped at resolution, so two
 * environments differing only there produce the SAME run and must compare equal
 * here too — otherwise the guard blocks edits over a difference that costs
 * nothing.
 *
 * `modelsEnabled` is true only when the surface opted the models slot in AND
 * the backend capability settled true.
 */
export type EnabledStackSlots = {
  skillsEnabled: boolean;
  computersEnabled: boolean;
  modelsEnabled?: boolean;
};

/** Slot-by-slot equality over the slots the project has enabled. */
function enabledSlotsEqual(
  a: ProjectEnvironmentView,
  b: ProjectEnvironmentView,
  enabled: EnabledStackSlots,
): boolean {
  return (
    (a.serverAttachmentId ?? null) === (b.serverAttachmentId ?? null) &&
    (!enabled.computersEnabled ||
      (a.computerEnvironmentId ?? null) ===
        (b.computerEnvironmentId ?? null)) &&
    (!enabled.skillsEnabled ||
      sameSkillSelection(a.skillSelection, b.skillSelection))
  );
}

/**
 * A selection with plugin pins cannot be represented as a stack AT ALL: the
 * stack has no plugin slot, and the resolver deliberately never reuses a pinned
 * named row — so the first stack edit resolves rows WITHOUT the pins and the run
 * silently sheds the plugin versions the user picked. Callers block stack edits
 * while this holds, exactly like {@link environmentsExceedOneStack}; it is a
 * separate predicate because it holds even for a SINGLE environment, and a
 * surface may want to keep its selection picker usable while only the slots are
 * blocked.
 */
export function environmentsCarryPluginPins(
  environments: ProjectEnvironmentView[],
): boolean {
  return environments.some((env) => (env.pluginVersionIds?.length ?? 0) > 0);
}

/**
 * True when any selected environment carries a stored model override.
 *
 * Surfaces that do not enable the models slot must block stack edits while
 * this holds — otherwise the first edit would mint inherit cells and silently
 * shed the override (D2).
 */
export function environmentsCarryModels(
  environments: readonly ProjectEnvironmentView[],
): boolean {
  return environments.some((env) => Boolean(env.modelId));
}

function modelChoiceKey(env: ProjectEnvironmentView): string {
  return env.modelId ?? "__inherit__";
}

function modelChoiceSetsAgree(
  environments: readonly ProjectEnvironmentView[],
): boolean {
  const byHost = new Map<string, Set<string>>();
  for (const env of environments) {
    if (!env.hostId) return false;
    const set = byHost.get(env.hostId) ?? new Set();
    set.add(modelChoiceKey(env));
    byHost.set(env.hostId, set);
  }
  if (byHost.size === 0) return true;
  const first = [...byHost.values()][0]!;
  const firstKey = [...first].sort().join("\0");
  return [...byHost.values()].every(
    (set) => [...set].sort().join("\0") === firstKey,
  );
}

function reconstructModelSelection(
  environments: readonly ProjectEnvironmentView[],
  slots?: EnabledStackSlots,
): ModelSelection {
  if (slots?.modelsEnabled !== true) {
    return emptyModelSelection();
  }
  const keys = new Set<string>();
  for (const env of environments) {
    keys.add(modelChoiceKey(env));
  }
  return {
    includeClientDefaults: keys.has("__inherit__") || keys.size === 0,
    explicitModelIds: [...keys].filter((k) => k !== "__inherit__").sort(),
  };
}

/**
 * True when a selection CANNOT be round-tripped through a stack without changing
 * what runs. Two ways that happens, and both cost a real thing:
 *
 *  - TWO ENVIRONMENTS ON ONE CLIENT. The stack's fan-out axis is `hostIds`, so
 *    they collapse to a single host and resolve to a single row — the selection
 *    comes back with fewer targets than it went in with.
 *  - DISAGREEING SHARED SLOTS. A stack has ONE server group, ONE skill
 *    selection, ONE image for all of its clients. Seeding a disagreement reads
 *    the slot as empty, so the first edit would resolve every client with
 *    defaults and quietly replace each environment's distinct execution context.
 *    Only slots the project has ENABLED count — a disabled slot is dropped at
 *    resolution, so disagreeing there changes nothing.
 *
 * With `modelsEnabled`, two same-host environments that differ only by model
 * choice are representable (inherit ∪ explicit). Per-host asymmetry — one
 * client carrying a different choice set — still collapses. Duplicate
 * (host, model) cells still collapse.
 *
 * Neither is the deliberate homogenizing the compose model is allowed to do (the
 * user picking a shared value and applying it) — both are silent losses. Callers
 * block stack edits while this holds; changing the SELECTION is the way out.
 * (Plugin pins are the third way a selection can't round-trip — see
 * {@link environmentsCarryPluginPins}. Model-bearing rows on a models-disabled
 * surface are the fourth — see {@link environmentsCarryModels}.)
 */
export function environmentsExceedOneStack(
  environments: ProjectEnvironmentView[],
  enabled: EnabledStackSlots,
): boolean {
  if (environments.length < 2) return false;

  if (enabled.modelsEnabled === true) {
    if (
      environments.some(
        (env) => !enabledSlotsEqual(env, environments[0], enabled),
      )
    ) {
      return true;
    }
    const cells = environments.map(
      (env) => `${env.hostId}::${modelChoiceKey(env)}`,
    );
    if (new Set(cells).size !== cells.length) return true;
    return !modelChoiceSetsAgree(environments);
  }

  const hosts = new Set(environments.map((e) => e.hostId));
  if (hosts.size !== environments.length) return true;
  return environments.some(
    (env) => !enabledSlotsEqual(env, environments[0], enabled),
  );
}

/**
 * Composer state for a surface whose `environmentIds` are already PERSISTED.
 *
 * The stack is what the selection has in common: every attached environment's
 * client, plus each shared slot's value when all of them agree ON THAT SLOT.
 * A disagreeing slot reads empty rather than picking a winner — editing another
 * slot would otherwise silently impose one environment's server group on the
 * rest, which is why {@link environmentsExceedOneStack} blocks editing in
 * exactly that case. Agreement is per slot, not all-or-nothing: a selection that
 * disagrees only on a flag-disabled slot stays editable, and imposing null on
 * the server group everyone shares would be its own silent change.
 *
 * Ad-hoc rows seed as a COMPOSITION, not a selection: they are deliberately not
 * offerable in the saved-environment picker, so presenting them there would
 * render a row of identical, undetachable "Automatic environment" chips. Their
 * stack is the honest description of them.
 *
 * Pass `slots` with `modelsEnabled: true` to reconstruct `modelSelection`
 * from the attached cells. Without it the axis stays at the inherit default
 * so a models-disabled surface never claims an override it cannot send.
 */
export function composerStateFromEnvironments(
  environments: ProjectEnvironmentView[],
  slots?: EnabledStackSlots,
): EnvironmentComposerState {
  const hostIds: string[] = [];
  for (const env of environments) {
    if (env.hostId && !hostIds.includes(env.hostId)) hostIds.push(env.hostId);
  }
  const first = environments[0];
  const sharedSlot = <T>(
    pick: (env: ProjectEnvironmentView) => T | null,
    equal: (a: T | null, b: T | null) => boolean,
  ): T | null =>
    first && environments.every((env) => equal(pick(env), pick(first)))
      ? pick(first)
      : null;

  const allNamed =
    environments.length > 0 && environments.every(isNamedEnvironment);
  return {
    environmentIds: allNamed ? environments.map((e) => e.environmentId) : [],
    stack: {
      hostIds,
      serverAttachmentId: sharedSlot(
        (env) => env.serverAttachmentId ?? null,
        (a, b) => a === b,
      ),
      skillSelection: sharedSlot(
        (env) => env.skillSelection ?? null,
        sameSkillSelection,
      ),
      computerEnvironmentId: sharedSlot(
        (env) => env.computerEnvironmentId ?? null,
        (a, b) => a === b,
      ),
      modelSelection: reconstructModelSelection(environments, slots),
    },
    customized: !allNamed,
  };
}

/** Compose path: customized with clients, or clients-only with no selection. */
export function isComposeMode(state: EnvironmentComposerState): boolean {
  if (state.environmentIds.length === 0) return state.stack.hostIds.length > 0;
  return state.customized;
}

/**
 * Whether this state names anywhere to run — asked of the ACTIVE mode, which is
 * the only way to get it right.
 *
 * A composition resolves through its CLIENTS × model choices, so an environment
 * that was picked and then edited has a selection and still no target. Asking
 * "is anything selected?" instead would let a surface enable Save on a state
 * that can only fail to resolve, and would make "I cleared the clients" (or
 * unchecked every model choice) indistinguishable from "I picked something".
 */
export function composerHasTarget(state: EnvironmentComposerState): boolean {
  if (!isComposeMode(state)) return state.environmentIds.length > 0;
  return (
    state.stack.hostIds.length > 0 &&
    modelChoiceCount(state.stack.modelSelection ?? emptyModelSelection()) > 0
  );
}

/** Count used for intensity / session estimates before resolution. */
export function composerTargetCount(state: EnvironmentComposerState): number {
  if (isComposeMode(state)) {
    return (
      state.stack.hostIds.length *
      modelChoiceCount(state.stack.modelSelection ?? emptyModelSelection())
    );
  }
  return state.environmentIds.length;
}

export function sameSkillSelection(
  a: ProjectEnvironmentSkillSelection | null | undefined,
  b: ProjectEnvironmentSkillSelection | null | undefined,
): boolean {
  const left = a ?? null;
  const right = b ?? null;
  if (left === null || right === null) return left === right;
  if (left.skillIds.length !== right.skillIds.length) return false;
  if (!left.skillIds.every((id, i) => id === right.skillIds[i])) return false;
  return sameVersionPins(left.versionPins, right.versionPins);
}

/**
 * Version pins compared as a SET keyed by skill: which revision each skill is
 * held at is what matters, not the order they were written in. Absent and empty
 * are the same thing (nothing pinned) — the backend stores absent, but a picker
 * mid-edit can easily produce `[]`, and treating those as different would mark
 * an untouched form dirty.
 */
function sameVersionPins(
  a: ProjectEnvironmentSkillSelection["versionPins"],
  b: ProjectEnvironmentSkillSelection["versionPins"],
): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  const bySkill = new Map(right.map((pin) => [pin.skillId, pin.versionId]));
  return left.every((pin) => bySkill.get(pin.skillId) === pin.versionId);
}

export function stackFieldsEqual(
  a: Pick<
    EnvironmentStack,
    "serverAttachmentId" | "skillSelection" | "computerEnvironmentId"
  >,
  b: Pick<
    EnvironmentStack,
    "serverAttachmentId" | "skillSelection" | "computerEnvironmentId"
  >,
): boolean {
  return (
    (a.serverAttachmentId ?? null) === (b.serverAttachmentId ?? null) &&
    (a.computerEnvironmentId ?? null) === (b.computerEnvironmentId ?? null) &&
    sameSkillSelection(a.skillSelection, b.skillSelection)
  );
}

/**
 * Model equality for environment REUSE, where absent means "inherit the
 * client's model" and is a real, distinct choice — never a wildcard.
 *
 * Deliberately not folded into `stackFieldsEqual`: that predicate also backs
 * the round-trip checks, which treat the model slot separately. So every site
 * that reuses an existing row has to pair the two — and this lives here, beside
 * its partner, because when it existed privately in one resolver the second
 * matcher simply did not compare models at all.
 */
export function sameOptionalModel(
  left: string | undefined,
  right: string | undefined,
): boolean {
  return (left ?? null) === (right ?? null);
}

/** Shared product-cap copy for both pills (D6). */
export function targetProductCapReason(
  hostCount: number,
  choiceCount: number,
  max: number,
): string {
  const clients = `${hostCount} client${hostCount === 1 ? "" : "s"}`;
  const models = `${choiceCount} model choice${choiceCount === 1 ? "" : "s"}`;
  return `${clients} × ${models} = ${
    hostCount * choiceCount
  } targets; limit ${max}`;
}

export type TargetBudgetContext = {
  hostCount: number;
  choiceCount: number;
  maxTargets: number;
};
