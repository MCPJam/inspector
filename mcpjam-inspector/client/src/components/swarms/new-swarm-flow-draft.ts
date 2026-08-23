/**
 * Remount-durable draft of the New swarm create flow.
 *
 * The flow's whole state lives in component state, and the surfaces above it
 * unmount for reasons that have nothing to do with the user: every Convex
 * `useQuery` re-resolves to `undefined` after a websocket reconnect (the client
 * throws its remote query set away in `onOpen`), and a backgrounded tab is
 * reconnected on return — so the route's "still deciding who you are" spinner
 * takes the subtree down mid-flow and the generated personas go with it. Work
 * the user already paid a model call for must not depend on the tab staying in
 * the foreground, so the resumable part of the flow is mirrored here.
 *
 * `sessionStorage`, like {@link module:lib/environment-draft-seed}: the draft has
 * to survive a remount AND a reload of `/swarms/new` (both land on the same tab)
 * but must die with the tab — a week-old slate silently reappearing on Confirm
 * would be its own bug. `savedAt` bounds the same risk within a long-lived tab.
 *
 * ONE project's flow is stored at a time: the flow is a full-page route, so a
 * second project's draft can only exist after the user left the first, and
 * keying by project (rather than accumulating a map) means a stale entry can
 * never be resurrected by switching back.
 *
 * The launch bookkeeping (`launch`) is here for a sharper reason than
 * convenience: those ids are what make a relaunch idempotent. Losing them to a
 * remount is what would create a SECOND persona and journey per proposal on the
 * retry — the gap the in-memory refs called out and could not close.
 */
import {
  emptyModelSelection,
  type EnvironmentComposerState,
} from "@/components/environment-composer/environment-stack";
import type {
  LaunchTarget,
  ProposedPersona,
} from "@/components/swarms/new-swarm-confirm-step";
import type { SwarmLaunchedRun } from "@/components/swarms/new-swarm-running-step";
import type { SwarmPushIntensity } from "@/components/swarms/swarm-intensity";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";

const STORAGE_KEY = "mcp-new-swarm-flow-draft";
const DRAFT_VERSION = 1;
/** A tab left open across a working day resumes nothing. */
const DRAFT_MAX_AGE_MS = 4 * 60 * 60 * 1000;

export type NewSwarmFlowStep = "describe" | "confirm" | "running";

/** Ids a retry must reuse so the backend replays rows instead of doubling them. */
export type NewSwarmLaunchIdentity = {
  flowId: string | null;
  swarmId: string | null;
  runGroupId: string | null;
  targets: LaunchTarget[] | null;
  /** `environmentSelectionKey` those targets were created for. */
  environmentKey: string | null;
};

export type NewSwarmFlowDraft = {
  step: NewSwarmFlowStep;
  /** The Describe step's Swarm name field. */
  name: string;
  /**
   * Whether the user typed in the name field.
   *
   * Persisted rather than derived: the field is PREFILLED, so "differs from the
   * suggestion" is the only way to tell an edit from an untouched form — and
   * after a remount the restored name IS the starting value, which made an
   * edited name look untouched and got its draft cleared.
   */
  nameEdited: boolean;
  description: string;
  targetState: EnvironmentComposerState;
  resolvedEnvironmentIds: string[] | null;
  resolvedEnvironments: ProjectEnvironmentView[] | null;
  createdEnvOverlay: ProjectEnvironmentView[];
  pushIntensity: SwarmPushIntensity;
  reusedIds: string[];
  proposed: ProposedPersona[];
  launchedRuns: SwarmLaunchedRun[];
  /** `launchedRunLabelsRef` as entries — a Map is not JSON. */
  runLabels: [string, string][];
  /**
   * When the in-flight generation started, or null. A generation cannot be
   * resumed (the request died with the unmounted component), so this is kept
   * only so the restored flow can SAY that instead of silently showing an empty
   * Describe step.
   */
  generatingSince: number | null;
  launch: NewSwarmLaunchIdentity;
};

type StoredDraft = {
  version: number;
  savedAt: number;
  projectId: string;
  draft: NewSwarmFlowDraft;
};

const FLOW_STEPS: NewSwarmFlowStep[] = ["describe", "confirm", "running"];
const INTENSITIES: SwarmPushIntensity[] = ["quick", "standard", "launch"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isLabelEntries(value: unknown): value is [string, string][] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string"
    )
  );
}

/**
 * Structural checks on the fields whose shape the flow WRITES from — a proposal
 * missing its keys would create a nameless persona, and a target missing its
 * journeyId would launch nothing. Everything else is read back as-is: this is
 * our own same-tab write behind a version, not untrusted input.
 */
function isProposedPersonaArray(value: unknown): value is ProposedPersona[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.key === "string" &&
        typeof entry.name === "string" &&
        typeof entry.role === "string" &&
        typeof entry.avatarShape === "number" &&
        typeof entry.avatarPalette === "number" &&
        Array.isArray(entry.journeys) &&
        entry.journeys.every(
          (journey) =>
            isRecord(journey) &&
            typeof journey.key === "string" &&
            typeof journey.goal === "string"
        )
    )
  );
}

function isLaunchedRunArray(value: unknown): value is SwarmLaunchedRun[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.runId === "string" &&
        typeof entry.journeyId === "string" &&
        typeof entry.personaId === "string" &&
        typeof entry.label === "string"
    )
  );
}

function isLaunchTargetArray(value: unknown): value is LaunchTarget[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.journeyId === "string" &&
        typeof entry.label === "string" &&
        typeof entry.personaId === "string"
    )
  );
}

function isComposerState(value: unknown): value is EnvironmentComposerState {
  if (!isRecord(value)) return false;
  if (!isStringArray(value.environmentIds)) return false;
  if (typeof value.customized !== "boolean") return false;
  const stack = value.stack;
  return isRecord(stack) && isStringArray(stack.hostIds);
}

/**
 * Fill in a model selection the stored draft predates.
 *
 * The shape is tolerated rather than required, like `name` above — a draft
 * written before the model slot existed is still resumable, and its stack is
 * exactly what a client-defaults selection means. Normalizing on the way out
 * keeps every reader working on a complete stack.
 */
function withModelSelection(
  state: EnvironmentComposerState
): EnvironmentComposerState {
  const selection = (state.stack as { modelSelection?: unknown }).modelSelection;
  if (
    isRecord(selection) &&
    typeof selection.includeClientDefaults === "boolean" &&
    isStringArray(selection.explicitModelIds)
  ) {
    return state;
  }
  return {
    ...state,
    stack: { ...state.stack, modelSelection: emptyModelSelection() },
  };
}

function isEnvironmentArray(value: unknown): value is ProjectEnvironmentView[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) => isRecord(entry) && typeof entry.environmentId === "string"
    )
  );
}

function isLaunchIdentity(value: unknown): value is NewSwarmLaunchIdentity {
  if (!isRecord(value)) return false;
  const nullableString = (field: unknown) =>
    field === null || typeof field === "string";
  return (
    nullableString(value.flowId) &&
    nullableString(value.swarmId) &&
    nullableString(value.runGroupId) &&
    nullableString(value.environmentKey) &&
    (value.targets === null || isLaunchTargetArray(value.targets))
  );
}

function parseDraft(value: unknown): NewSwarmFlowDraft | null {
  if (!isRecord(value)) return null;
  const step = value.step;
  const intensity = value.pushIntensity;
  if (typeof step !== "string" || !FLOW_STEPS.includes(step as NewSwarmFlowStep)) {
    return null;
  }
  if (
    typeof intensity !== "string" ||
    !INTENSITIES.includes(intensity as SwarmPushIntensity)
  ) {
    return null;
  }
  if (typeof value.description !== "string") return null;
  // Tolerated rather than required: a draft written by a build before the Swarm
  // name field existed is still resumable, and rejecting it would throw away a
  // generated slate the user paid a model call for. The flow falls back to the
  // suggested name for an empty string.
  const name = typeof value.name === "string" ? value.name : "";
  // Tolerated like `name`: a draft written before this field existed is still
  // resumable, and its other fields are what made it resumable anyway.
  const nameEdited = value.nameEdited === true;
  if (!isComposerState(value.targetState)) return null;
  if (
    value.resolvedEnvironmentIds !== null &&
    !isStringArray(value.resolvedEnvironmentIds)
  ) {
    return null;
  }
  if (
    value.resolvedEnvironments !== null &&
    !isEnvironmentArray(value.resolvedEnvironments)
  ) {
    return null;
  }
  if (!isEnvironmentArray(value.createdEnvOverlay)) return null;
  if (!isStringArray(value.reusedIds)) return null;
  if (!isProposedPersonaArray(value.proposed)) return null;
  if (!isLaunchedRunArray(value.launchedRuns)) return null;
  if (!isLabelEntries(value.runLabels)) return null;
  if (value.generatingSince !== null && typeof value.generatingSince !== "number") {
    return null;
  }
  if (!isLaunchIdentity(value.launch)) return null;

  return {
    step: step as NewSwarmFlowStep,
    name,
    nameEdited,
    description: value.description,
    targetState: withModelSelection(value.targetState),
    resolvedEnvironmentIds: value.resolvedEnvironmentIds,
    resolvedEnvironments: value.resolvedEnvironments,
    createdEnvOverlay: value.createdEnvOverlay,
    pushIntensity: intensity as SwarmPushIntensity,
    reusedIds: value.reusedIds,
    proposed: value.proposed,
    launchedRuns: value.launchedRuns,
    runLabels: value.runLabels,
    generatingSince: value.generatingSince,
    launch: value.launch,
  };
}

export function saveNewSwarmFlowDraft(
  projectId: string,
  draft: NewSwarmFlowDraft
): void {
  const key = projectId.trim();
  if (!key) return;
  const stored: StoredDraft = {
    version: DRAFT_VERSION,
    savedAt: Date.now(),
    projectId: key,
    draft,
  };
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Storage unavailable (or full) ⇒ the flow degrades to today's behavior:
    // in-memory only. Never worth failing the authoring screen over.
  }
}

/**
 * The stored draft for this project, or null when there is nothing resumable —
 * absent, another project's, a different version, too old, or unparseable.
 * Nothing is deleted on read: a remount that reads the draft must still find it
 * after ITS remount.
 */
export function readNewSwarmFlowDraft(
  projectId: string | null | undefined
): NewSwarmFlowDraft | null {
  const key = projectId?.trim();
  if (!key) return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (parsed.version !== DRAFT_VERSION) return null;
    if (parsed.projectId !== key) return null;
    if (
      typeof parsed.savedAt !== "number" ||
      Date.now() - parsed.savedAt > DRAFT_MAX_AGE_MS
    ) {
      return null;
    }
    return parseDraft(parsed.draft);
  } catch {
    return null;
  }
}

/** Drop the draft. Called when the user LEAVES the flow, never on a remount. */
export function clearNewSwarmFlowDraft(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do — a draft we can't delete is bounded by `savedAt` anyway.
  }
}
