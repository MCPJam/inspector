/**
 * Turn composer state into real project-environment ids, for every surface that
 * has to launch something.
 *
 * Nothing runs against a loose composition: suites, journeys, and scenarios all
 * store `environmentIds`, and the backend resolves those at launch. So a
 * customized stack has to become rows first. Ad-hoc environments are what make
 * that cheap — the backend fingerprints the composition and returns the existing
 * row when one matches, so the same stack resolves to the same id forever and
 * the Environments list never fills up with machine-named junk.
 *
 * The mutation is INJECTED rather than imported so this module stays pure and
 * directly testable; callers use {@link useComposerResolver}.
 */
import {
  expandModelChoices,
  isComposeMode,
  modelChoiceCount,
  modelSelectionForHost,
  sameOptionalModel,
  stackFieldsEqual,
  targetProductCapReason,
  type EnvironmentComposerState,
  type EnvironmentStack,
  type ModelSelection,
  type SkippedModelCell,
} from "@/components/environment-composer/environment-stack";
import type { HarnessModelTarget } from "@/lib/harness-model-locks";
import {
  selectionKey,
  type ModelSelection as SavedModelSelection,
} from "@mcpjam/sdk/browser";
import { isNamedEnvironment } from "@/lib/environment-label";
import { clientDisplayName } from "@/lib/client-display-name";
import type {
  ProjectEnvironmentSkillSelection,
  ProjectEnvironmentView,
} from "@/hooks/useProjectEnvironments";

/** One composition, in the shape `ensureAdhocEnvironments` accepts. */
export type AdhocStackInput = {
  hostId: string;
  serverAttachmentId?: string | null;
  skillSelection?: ProjectEnvironmentSkillSelection | null;
  computerEnvironmentId?: string;
  /** Explicit model override. Omit to inherit the client's model. */
  modelId?: string;
  /** Saved selection behind `modelId` (only with `modelSelectionsEnabled`). */
  modelSelection?: SavedModelSelection;
};

export type EnsureAdhocEnvironmentsFn = (args: {
  projectId: string;
  stacks: AdhocStackInput[];
}) => Promise<
  Array<{ environment: ProjectEnvironmentView; created?: boolean }>
>;

export type ComposerResolveErrorCode =
  | "NO_TARGETS"
  | "TOO_MANY_TARGETS"
  | "UNRESOLVED_ENVIRONMENT"
  | "ADHOC_UNAVAILABLE"
  | "BACKEND_REJECTED";

export class ComposerResolveError extends Error {
  readonly code: ComposerResolveErrorCode;
  constructor(code: ComposerResolveErrorCode, message: string) {
    super(message);
    this.name = "ComposerResolveError";
    this.code = code;
  }
}

/**
 * The backend predates ad-hoc environments.
 *
 * The inspector also ships as a desktop app, so a new build can meet an
 * arbitrarily old self-hosted backend. Convex answers a call for a function it
 * does not have with this message, and it is the only signal available — the
 * error carries no code. Callers translate it into whatever their surface can
 * still do (Swarms falls back to naming rows; every other surface tells the user
 * to pick a saved environment instead).
 */
export function isAdhocUnavailable(err: unknown): boolean {
  if (err instanceof ComposerResolveError)
    return err.code === "ADHOC_UNAVAILABLE";
  return /could not find public function/i.test(backendMessage(err) ?? "");
}

/** The backend's own sentence, when it sent one. */
function backendMessage(err: unknown): string | undefined {
  const data = (err as { data?: unknown } | null)?.data;
  if (typeof data === "string" && data) return data;
  if (data && typeof data === "object") {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  if (err instanceof Error && err.message) return err.message;
  return undefined;
}

export type ResolveComposerResult = {
  /** Ordered, deduped, ready to persist. */
  environmentIds: string[];
  /** The rows behind those ids, same order — for labels and compat payloads. */
  environments: ProjectEnvironmentView[];
  /** Ids the backend newly minted. Absent `created` reads as a reuse. */
  createdIds: string[];
  /** Ids that already existed (matched fingerprint, or a named row we reused). */
  reusedIds: string[];
  /**
   * Client × model cells left out because the client's harness cannot run the
   * model (see `expandModelChoices`). Empty when nothing was skipped; surfaces
   * show these so a dropped pair is never silent.
   */
  skipped: SkippedModelCell[];
};

/**
 * The shared fields every host in this composition runs under.
 *
 * Flag-gated slots are dropped, not sent as null: a project without
 * `skills-enabled` and a project that has it but pinned nothing must produce the
 * SAME environment, because the resolver treats them identically. The
 * fingerprint is a function of the stored row, never of the request.
 */
function sharedFields(
  stack: EnvironmentStack,
  skillsEnabled: boolean,
  computersEnabled: boolean,
) {
  return {
    serverAttachmentId: stack.serverAttachmentId ?? null,
    skillSelection: skillsEnabled ? (stack.skillSelection ?? null) : null,
    computerEnvironmentId: computersEnabled
      ? (stack.computerEnvironmentId ?? null)
      : null,
  };
}

/**
 * A live NAMED environment that already IS this composition.
 *
 * Without this, composing a stack identical to an environment someone curated
 * mints an unnamed twin beside it — the run loses the name, and on User Testing
 * it would publish a second scenario next to the named environment's existing
 * one. The backend's dedupe cannot cover this case: its index is keyed on
 * `origin`, so only ad-hoc rows dedupe against each other by construction.
 *
 * Rows with plugin pins never match. The strip has no plugin slot, so a pinned
 * environment is a strictly different stack — reusing it would silently run
 * pinned plugin versions the user never asked for.
 */
function matchingNamedEnvironment(
  hostId: string,
  fields: ReturnType<typeof sharedFields>,
  liveEnvironments: ProjectEnvironmentView[],
  /**
   * Ids the user actually picked. Preferred when several named rows match,
   * because identical stacks make the rows interchangeable to US and not to the
   * user: on User Testing, silently swapping to another matching row opens or
   * publishes a DIFFERENT environment's scenario, with its own name and access.
   */
  preferIds: readonly string[] = [],
  /** Inherit cell = undefined. A named row with an override must not match. */
  modelId?: string,
  /**
   * The cell's saved selection. When set, a named row is reused only if it
   * saved the SAME selection — an org-connection pick must not reuse a row
   * that runs the same id on the hosted catalog.
   */
  modelSelection?: SavedModelSelection,
): ProjectEnvironmentView | undefined {
  const matches = (env: ProjectEnvironmentView) =>
    !env.archivedAt &&
    env.hostId === hostId &&
    isNamedEnvironment(env) &&
    (env.pluginVersionIds?.length ?? 0) === 0 &&
    sameOptionalModel(env.modelId, modelId) &&
    (!modelSelection ||
      (env.modelSelection !== undefined &&
        selectionKey(env.modelSelection) === selectionKey(modelSelection))) &&
    stackFieldsEqual(
      {
        serverAttachmentId: env.serverAttachmentId ?? null,
        skillSelection: env.skillSelection ?? null,
        computerEnvironmentId: env.computerEnvironmentId ?? null,
      },
      fields,
    );

  for (const id of preferIds) {
    const env = liveEnvironments.find((e) => e.environmentId === id);
    if (env && matches(env)) return env;
  }
  return liveEnvironments.find(matches);
}

export async function resolveComposerEnvironments(args: {
  projectId: string;
  state: EnvironmentComposerState;
  /** Everything this client knows about, for saved-id lookup and named reuse. */
  liveEnvironments: ProjectEnvironmentView[];
  ensureAdhocEnvironments: EnsureAdhocEnvironmentsFn;
  skillsEnabled: boolean;
  computersEnabled: boolean;
  /** Fan-out cap this surface enforces. */
  max: number;
  /**
   * Backend `modelMatrix` capability. Undefined / false means this client
   * must not send `modelId` — an older validator would reject the arg.
   */
  modelMatrixEnabled?: boolean;
  /**
   * The harness a client runs (`null` = emulated). Injected, like the
   * mutation, so this module stays pure. Only consulted for clients with
   * explicit model choices; absent ⇒ no client × model cell is skipped here
   * (the server's admission still refuses an incompatible pair).
   */
  loadHostHarness?: (hostId: string) => Promise<HarnessModelTarget | null>;
  /**
   * Backend `modelSelections` capability. Undefined / false means this client
   * must not send `modelSelection` — an older validator would reject the arg;
   * the cell then mints with its legacy `modelId` alone.
   */
  modelSelectionsEnabled?: boolean;
}): Promise<ResolveComposerResult> {
  const {
    projectId,
    state,
    liveEnvironments,
    ensureAdhocEnvironments,
    skillsEnabled,
    computersEnabled,
    max,
    modelMatrixEnabled = false,
    loadHostHarness,
    modelSelectionsEnabled = false,
  } = args;

  const live = liveEnvironments.filter((e) => !e.archivedAt);

  // Saved-environment path: nothing to resolve, just prove every id is real.
  if (!isComposeMode(state)) {
    if (state.environmentIds.length === 0) {
      throw new ComposerResolveError(
        "NO_TARGETS",
        "Pick an environment or a client to choose where this runs.",
      );
    }
    const environments: ProjectEnvironmentView[] = [];
    for (const environmentId of state.environmentIds) {
      const env = live.find((e) => e.environmentId === environmentId);
      if (!env) {
        // Archived or deleted since it was attached. Persisting it would leave
        // a target that can never launch, so make the user detach it instead.
        throw new ComposerResolveError(
          "UNRESOLVED_ENVIRONMENT",
          "One of the selected environments is no longer available. Remove it and pick another.",
        );
      }
      environments.push(env);
    }
    return {
      environmentIds: environments.map((e) => e.environmentId),
      environments,
      createdIds: [],
      reusedIds: environments.map((e) => e.environmentId),
      skipped: [],
    };
  }

  const hostIds = [...new Set(state.stack.hostIds.filter(Boolean))];
  const selectionsByHost = hostIds.map((hostId) => ({
    hostId,
    selection: normalizeModelSelection(
      modelSelectionForHost(state.stack, hostId),
    ),
  }));
  if (
    hostIds.length === 0 ||
    selectionsByHost.some(
      ({ selection }) => expandModelChoices(selection).cells.length === 0,
    )
  ) {
    throw new ComposerResolveError(
      "NO_TARGETS",
      selectionsByHost.some(
        ({ selection }) => expandModelChoices(selection).cells.length === 0,
      )
        ? "Pick at least one model choice — Client defaults or a catalog model."
        : "Pick at least one client to choose where this runs.",
    );
  }
  if (
    selectionsByHost.some(
      ({ selection }) => selection.explicitModelIds.length > 0,
    ) &&
    modelMatrixEnabled !== true
  ) {
    throw new ComposerResolveError(
      "BACKEND_REJECTED",
      "This workspace's backend doesn't support model fan-out yet. Leave Client defaults selected, or upgrade the backend.",
    );
  }
  const product = selectionsByHost.reduce(
    (total, { selection }) => total + modelChoiceCount(selection),
    0,
  );
  if (product > max) {
    throw new ComposerResolveError(
      "TOO_MANY_TARGETS",
      state.stack.modelSelectionsByHost
        ? `${product} targets; limit ${max}`
        : targetProductCapReason(
            hostIds.length,
            modelChoiceCount(selectionsByHost[0]!.selection),
            max,
          ),
    );
  }

  const fields = sharedFields(state.stack, skillsEnabled, computersEnabled);

  type Cell = {
    hostId: string;
    modelId: string | undefined;
    modelSelection?: SavedModelSelection;
    key: string;
  };
  const cells: Cell[] = [];
  const skipped: SkippedModelCell[] = [];
  for (const { hostId, selection } of selectionsByHost) {
    // Only a client with explicit picks can have a pair to skip, so only those
    // pay for the harness read.
    const harness =
      loadHostHarness && selection.explicitModelIds.length > 0
        ? await loadHostHarness(hostId)
        : null;
    const expanded = expandModelChoices(selection, {
      clientId: hostId,
      harness,
    });
    // A client whose every choice is a pair its harness cannot run contributes
    // no cells; its pairs stay in `skipped`, which the surface reports. The
    // model picker admits a model any selected client can run, so one such
    // client must not sink the resolve for the others.
    skipped.push(...expanded.skipped);
    for (const choice of expanded.cells) {
      // A selection the backend cannot store must not steer reuse either.
      const modelSelection = modelSelectionsEnabled
        ? choice.modelSelection
        : undefined;
      cells.push({
        hostId,
        modelId: choice.modelId,
        ...(modelSelection ? { modelSelection } : {}),
        key: cellKey(hostId, choice.modelId),
      });
    }
  }

  if (cells.length === 0) {
    // Nothing runnable anywhere: every chosen pair was one its client's
    // harness cannot run. Say so rather than persist an empty target list.
    throw new ComposerResolveError(
      "NO_TARGETS",
      `None of the chosen clients can run the chosen models: ${skipped[0]?.reason ?? "no runnable model"}.`,
    );
  }

  // Reuse named rows first; only the rest need minting.
  const reusedByCell = new Map<string, ProjectEnvironmentView>();
  const toMint: Cell[] = [];
  for (const cell of cells) {
    const named = matchingNamedEnvironment(
      cell.hostId,
      fields,
      live,
      state.environmentIds,
      cell.modelId,
      cell.modelSelection,
    );
    if (named) reusedByCell.set(cell.key, named);
    else toMint.push(cell);
  }

  const mintedByCell = new Map<
    string,
    { environment: ProjectEnvironmentView; created?: boolean }
  >();
  if (toMint.length > 0) {
    // `computerEnvironmentId` is omitted rather than sent as null — the mutation
    // types it `string?` and Convex rejects an explicit null at the validator.
    // Same for inherit-cell `modelId`.
    const stacks: AdhocStackInput[] = toMint.map((cell) => ({
      hostId: cell.hostId,
      ...(fields.serverAttachmentId
        ? { serverAttachmentId: fields.serverAttachmentId }
        : {}),
      ...(fields.skillSelection
        ? { skillSelection: fields.skillSelection }
        : {}),
      ...(fields.computerEnvironmentId
        ? { computerEnvironmentId: fields.computerEnvironmentId }
        : {}),
      ...(cell.modelId ? { modelId: cell.modelId } : {}),
      ...(cell.modelId && cell.modelSelection
        ? { modelSelection: cell.modelSelection }
        : {}),
    }));

    let results: Awaited<ReturnType<EnsureAdhocEnvironmentsFn>>;
    try {
      results = await ensureAdhocEnvironments({ projectId, stacks });
    } catch (err) {
      if (isAdhocUnavailable(err)) {
        throw new ComposerResolveError(
          "ADHOC_UNAVAILABLE",
          "This workspace's backend doesn't support quick setups yet. Pick a saved environment instead.",
        );
      }
      throw new ComposerResolveError(
        "BACKEND_REJECTED",
        backendMessage(err) ??
          "Could not resolve this setup into environments.",
      );
    }

    if (results.length !== toMint.length) {
      throw new ComposerResolveError(
        "BACKEND_REJECTED",
        "Could not resolve this setup into environments.",
      );
    }
    toMint.forEach((cell, i) => mintedByCell.set(cell.key, results[i]));
  }

  // Reassemble in host-major × model-choice order — the batch only covered mints.
  const environmentIds: string[] = [];
  const environments: ProjectEnvironmentView[] = [];
  const createdIds: string[] = [];
  const reusedIds: string[] = [];
  for (const cell of cells) {
    const reused = reusedByCell.get(cell.key);
    if (reused) {
      pushUnique(reused, environmentIds, environments, reusedIds);
      continue;
    }
    const minted = mintedByCell.get(cell.key);
    if (!minted) {
      throw new ComposerResolveError(
        "BACKEND_REJECTED",
        "Could not resolve this setup into environments.",
      );
    }
    pushUnique(
      minted.environment,
      environmentIds,
      environments,
      minted.created === true ? createdIds : reusedIds,
    );
  }

  return { environmentIds, environments, createdIds, reusedIds, skipped };
}

/**
 * The name a person knows a client by, for the skipped-pairs toast: the host
 * list's display name when the id is in it, else the raw id.
 */
export function clientNameResolver(
  hosts: ReadonlyArray<{ hostId: string; name: string; displayName?: string }>,
): (clientId: string) => string {
  return (clientId) => {
    const host = hosts.find((candidate) => candidate.hostId === clientId);
    return host ? clientDisplayName(host) : clientId;
  };
}

/**
 * One sentence naming the client × model pairs a resolve left out, for the
 * surface's warning toast; undefined when nothing was skipped.
 */
export function describeSkippedModelCells(
  skipped: readonly SkippedModelCell[] | undefined,
  clientName: (clientId: string) => string = (id) => id,
): string | undefined {
  if (!skipped || skipped.length === 0) return undefined;
  const pairs = skipped.map(
    (cell) => `${clientName(cell.clientId)} × ${cell.modelId} (${cell.reason})`,
  );
  return `Skipped ${skipped.length} client × model ${
    skipped.length === 1 ? "pair" : "pairs"
  } the client can't run: ${pairs.join("; ")}`;
}

function normalizeModelSelection(selection: ModelSelection): ModelSelection {
  const explicitModelIds = [
    ...new Set(selection.explicitModelIds.filter(Boolean)),
  ];
  const explicitModelSelections = Object.fromEntries(
    explicitModelIds.flatMap((id) => {
      const saved = selection.explicitModelSelections?.[id];
      return saved?.modelId === id ? [[id, saved] as const] : [];
    }),
  );
  return {
    includeClientDefaults: selection.includeClientDefaults,
    explicitModelIds,
    ...(Object.keys(explicitModelSelections).length > 0
      ? { explicitModelSelections }
      : {}),
  };
}

function cellKey(hostId: string, modelId: string | undefined): string {
  return `${hostId}::${modelId ?? ""}`;
}

/**
 * Two hosts can legitimately resolve to ONE row — a named environment matching
 * both, or a backend that fingerprints two stacks the same. Callers persist
 * `environmentIds` into fields with a no-duplicates constraint, so collapse here
 * rather than letting the write fail.
 */
function pushUnique(
  env: ProjectEnvironmentView,
  environmentIds: string[],
  environments: ProjectEnvironmentView[],
  bucket: string[],
) {
  if (environmentIds.includes(env.environmentId)) return;
  environmentIds.push(env.environmentId);
  environments.push(env);
  bucket.push(env.environmentId);
}
