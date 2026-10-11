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
  ProjectEnvironmentSecretSelection,
  ProjectEnvironmentSkillSelection,
  ProjectEnvironmentView,
} from "@/hooks/useProjectEnvironments";
import { isNamedEnvironment } from "@/lib/environment-label";
import {
  harnessChoiceRefusalReason,
  type HarnessModelTarget,
} from "@/lib/harness-model-locks";
import type { HarnessModelPurpose } from "@/shared/harness-model-support";
import type { ModelSelection as SavedModelSelection } from "@mcpjam/sdk/browser";
import type { ModelDefinition } from "@/shared/types";
import { selectionBesideLegacyId } from "@/components/chat-v2/shared/model-selection";
import {
  dedupeModelTargets,
  environmentModelTarget,
  modelTarget,
  modelTargetConfigKey,
  modelTargetKey,
  type ModelTarget,
} from "@/lib/model-target";

export type { ModelTarget } from "@/lib/model-target";
export { modelTargetKey } from "@/lib/model-target";

/**
 * Structured model axis (D2). Never auto-seed a host's default modelId as
 * an explicit pick — the fingerprint treats explicit-equals-default as a
 * distinct row.
 */
export type ModelSelection = {
  includeClientDefaults: boolean;
  /**
   * Explicit model choices in list order, unique by `comparisonKey`
   * ({@link modelTargetKey}): each is a model id plus the saved selection
   * (`@mcpjam/sdk` `ModelSelection`) behind it — which credentials and
   * settings the cell runs with. Two efforts of one model are two targets,
   * so two cells; a target with no selection is an unlabelled pick and runs
   * exactly like a bare id. See {@link syncExplicitTargets}.
   */
  explicitTargets: ModelTarget[];
};

export const DEFAULT_MODEL_SELECTION: ModelSelection = {
  includeClientDefaults: true,
  explicitTargets: [],
};

/** The distinct model ids among the explicit targets, in list order. */
export function explicitModelIds(
  selection: ModelSelection | undefined,
): string[] {
  return [
    ...new Set((selection?.explicitTargets ?? []).map((t) => t.modelId)),
  ];
}

/** Explicit targets from bare ids (no saved selections). */
export function modelSelectionFromIds(
  modelIds: readonly string[],
  includeClientDefaults = false,
): ModelSelection {
  return {
    includeClientDefaults,
    explicitTargets: dedupeModelTargets(modelIds.map((id) => modelTarget(id))),
  };
}

/**
 * Read a model selection stored by any build: today's `explicitTargets`, or
 * the older parallel `explicitModelIds` + `explicitModelSelections` (keyed by
 * id). `undefined` when the value is neither.
 */
export function parseStoredModelSelection(
  value: unknown,
): ModelSelection | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.includeClientDefaults !== "boolean") return undefined;
  if (Array.isArray(record.explicitTargets)) {
    const targets = record.explicitTargets.flatMap((entry): ModelTarget[] => {
      if (!entry || typeof entry !== "object") return [];
      const { modelId, selection } = entry as Record<string, unknown>;
      return typeof modelId === "string" && modelId
        ? [modelTarget(modelId, selection as SavedModelSelection | undefined)]
        : [];
    });
    return {
      includeClientDefaults: record.includeClientDefaults,
      explicitTargets: dedupeModelTargets(targets),
    };
  }
  const ids = record.explicitModelIds;
  if (Array.isArray(ids) && ids.every((id) => typeof id === "string")) {
    const saved = (record.explicitModelSelections ?? {}) as Record<
      string,
      SavedModelSelection | undefined
    >;
    return {
      includeClientDefaults: record.includeClientDefaults,
      explicitTargets: dedupeModelTargets(
        (ids as string[]).map((id) => modelTarget(id, saved[id])),
      ),
    };
  }
  return undefined;
}

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
  /**
   * Optional per-client model choices. The shared selection remains the
   * backwards-compatible fallback for surfaces that intentionally configure a
   * full client × model matrix.
   */
  modelSelectionsByHost?: Record<string, ModelSelection>;
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
  return { includeClientDefaults: true, explicitTargets: [] };
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

/** The model choices a particular client runs; falls back to the shared axis. */
export function modelSelectionForHost(
  stack: Pick<EnvironmentStack, "modelSelection" | "modelSelectionsByHost">,
  hostId: string,
): ModelSelection {
  return (
    stack.modelSelectionsByHost?.[hostId] ??
    stack.modelSelection ??
    emptyModelSelection()
  );
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
    (resolved.includeClientDefaults ? 1 : 0) + resolved.explicitTargets.length
  );
}

/** A client × model cell the client's harness cannot run, and why. */
export type SkippedModelCell = {
  clientId: string;
  modelId: string;
  reason: string;
};

/**
 * Inherit first, then explicit ids in list order. Host-major mint uses this.
 *
 * With a `harness` target, explicit models the harness cannot run for
 * `purpose` (the harness × model evidence table, at the runtime's pinned
 * version) are NOT minted into cells — they are returned in `skipped` with the
 * reason, so the surface can say which client × model pairs it left out
 * instead of minting an environment the run admission will refuse. The
 * inherit cell is never skipped here: the client's own model is the host's
 * configuration, judged by the server's admission.
 */
export function expandModelChoices(
  selection: ModelSelection | undefined,
  options?: {
    /** The client these choices fan out for (reported on skipped cells). */
    clientId?: string;
    /** The client's harness, `null`/absent for an emulated client. */
    harness?: HarnessModelTarget | null;
    /** Defaults to `eval`: every composer surface launches compared runs. */
    purpose?: HarnessModelPurpose;
  },
): {
  cells: Array<{
    modelId: string | undefined;
    /** The saved selection behind an explicit id, when it has one. */
    modelSelection?: SavedModelSelection;
  }>;
  skipped: SkippedModelCell[];
} {
  const resolved = selection ?? emptyModelSelection();
  const cells: Array<{
    modelId: string | undefined;
    modelSelection?: SavedModelSelection;
  }> = [];
  const skipped: SkippedModelCell[] = [];
  if (resolved.includeClientDefaults) {
    cells.push({ modelId: undefined });
  }
  for (const target of dedupeModelTargets(resolved.explicitTargets)) {
    const { modelId } = target;
    // The saved selection says whose key the choice runs on: a local key never
    // runs on a brokered harness, an org connection only on its own vendor.
    const reason = harnessChoiceRefusalReason(
      { modelId, selection: target.selection },
      options?.harness,
      options?.purpose ?? "eval",
    );
    if (reason) {
      skipped.push({ clientId: options?.clientId ?? "", modelId, reason });
      continue;
    }
    cells.push(
      target.selection
        ? { modelId, modelSelection: target.selection }
        : { modelId },
    );
  }
  return { cells, skipped };
}

/**
 * Fill in the saved selection of every explicit target that has none, after a
 * picker edit: the row the user just picked (when it is that id) wins, else
 * the first listed row with that id (hosted rows list first, matching the
 * legacy hosted-first read). A row that cannot be saved beside its unchanged
 * id ({@link selectionBesideLegacyId}) leaves the target unlabelled. A target
 * that already carries a selection keeps it, so two efforts of one model stay
 * two targets; the list is then deduped by `comparisonKey`.
 */
export function syncExplicitTargets(
  next: ModelSelection,
  context: {
    models: readonly ModelDefinition[];
    picked?: ModelDefinition;
  },
): ModelSelection {
  const targets = next.explicitTargets.map((target): ModelTarget => {
    const normalized = modelTarget(target.modelId, target.selection);
    if (normalized.selection) return normalized;
    const row =
      context.picked && String(context.picked.id) === target.modelId
        ? context.picked
        : context.models.find((model) => String(model.id) === target.modelId);
    return modelTarget(
      target.modelId,
      row ? selectionBesideLegacyId(row, "evalTarget") : undefined,
    );
  });
  return {
    includeClientDefaults: next.includeClientDefaults,
    explicitTargets: dedupeModelTargets(targets),
  };
}

/**
 * Same choices, order-insensitive. Config-strict: two effort levels of one
 * model, or a stored selection versus none, are different compositions.
 */
export function sameModelSelection(
  a: ModelSelection,
  b: ModelSelection,
): boolean {
  if (a.includeClientDefaults !== b.includeClientDefaults) return false;
  if (a.explicitTargets.length !== b.explicitTargets.length) return false;
  const left = a.explicitTargets.map(modelTargetConfigKey).sort();
  const right = b.explicitTargets.map(modelTargetConfigKey).sort();
  return left.every((key, i) => key === right[i]);
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
      explicitTargets: env.modelId
        ? [modelTarget(env.modelId, env.modelSelection)]
        : [],
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

/** The env's model choice by `comparisonKey`; the inherit cell otherwise. */
function modelChoiceKey(env: ProjectEnvironmentView): string {
  const target = environmentModelTarget(env);
  return target ? modelTargetKey(target) : "__inherit__";
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
  // One target per distinct comparisonKey: two efforts of one model are two
  // targets, never collapsed onto whichever environment came first.
  let inherit = false;
  const targets: ModelTarget[] = [];
  for (const env of environments) {
    const target = environmentModelTarget(env);
    if (target) targets.push(target);
    else inherit = true;
  }
  const explicitTargets = dedupeModelTargets(targets).sort((a, b) => {
    const left = modelTargetKey(a);
    const right = modelTargetKey(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return {
    includeClientDefaults: inherit || explicitTargets.length === 0,
    explicitTargets,
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
 * choice are representable (inherit ∪ explicit) — including two efforts of
 * one model, which are two targets by `comparisonKey`. Per-host asymmetry —
 * one client carrying a different choice set — still collapses. Duplicate
 * (host, comparisonKey) cells still collapse.
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
    state.stack.hostIds.every(
      (hostId) =>
        modelChoiceCount(modelSelectionForHost(state.stack, hostId)) > 0,
    )
  );
}

/** Count used for intensity / session estimates before resolution. */
export function composerTargetCount(state: EnvironmentComposerState): number {
  if (isComposeMode(state)) {
    return state.stack.hostIds.reduce(
      (total, hostId) =>
        total + modelChoiceCount(modelSelectionForHost(state.stack, hostId)),
      0,
    );
  }
  return state.environmentIds.length;
}

/**
 * Two secret selections are the same grant.
 *
 * ORDER-SENSITIVE, matching `sameSkillSelection` and the backend's own
 * order-preserving normalization: the stored array is what the fingerprint
 * hashes, so two orderings are two rows and a comparison that called them equal
 * would mark a real edit clean.
 *
 * Absent and null are the same thing (no grant); there is no empty-array case
 * to reconcile, because a picker that clears its last row emits `null`.
 */
export function sameSecretSelection(
  a: ProjectEnvironmentSecretSelection | null | undefined,
  b: ProjectEnvironmentSecretSelection | null | undefined,
): boolean {
  const left = a ?? null;
  const right = b ?? null;
  if (left === null || right === null) return left === right;
  if (left.secretIds.length !== right.secretIds.length) return false;
  return left.secretIds.every((id, index) => id === right.secretIds[index]);
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
