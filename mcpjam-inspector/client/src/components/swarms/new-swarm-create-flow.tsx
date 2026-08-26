/**
 * Full-page New swarm create flow: Describe → Confirm personas → Running.
 *
 * Describe has two optional sources (choose existing personas and/or describe
 * new ones), then a shared Environments + intensity block that applies to the
 * swarm as a whole. Reused personas keep their own journeys; intensity sizes
 * generation only. Primary action is always Continue.
 *
 * Nothing is written until Create & launch. After launch, Running shows the
 * live persona × client matrix; leaving keeps runs going on Overview.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";
import { ChevronLeft, Loader2, X } from "lucide-react";
import { PersonaPickerPopover } from "@/components/swarms/persona-picker-popover";
import { ProgressStepper } from "@/components/shared/progress-stepper";
import { RequiredMark } from "@/components/shared/required-mark";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { SwarmTargetComposer } from "@/components/swarms/swarm-target-composer";
import {
  resolveSwarmJourneyPayload,
  SwarmTargetMaterializeError,
  type CreateProjectEnvironmentFn,
} from "@/components/swarms/swarm-target-materialize";
import {
  buildEnvJourneyPayload,
  MAX_ENVIRONMENTS_PER_JOURNEY,
} from "@/components/swarms/journey-environments";
import {
  composerTargetCount,
  defaultComposerState,
  emptyComposerState,
  isComposeMode,
  type EnvironmentComposerState,
} from "@/components/environment-composer/environment-stack";
import {
  ComposerResolveError,
  isAdhocUnavailable,
} from "@/components/environment-composer/resolve-stacks";
import { useComposerResolver } from "@/components/environment-composer/use-composer-resolver";
import { useCloudServerReadiness } from "@/components/environment-composer/use-cloud-server-readiness";
import { MAX_PERSONAS_PER_PROJECT } from "@/components/swarms/GenerateSwarmDialog";
import {
  PersonaPixelAvatar,
  mintPersonaAvatarLook,
} from "@/components/swarms/persona-pixel-avatar";
import {
  NewSwarmConfirmStep,
  type ConfirmLaunchPayload,
  type LaunchTarget,
  type ProposedPersona,
  type ReusedPersona,
} from "@/components/swarms/new-swarm-confirm-step";
import {
  NewSwarmRunningStep,
  type SwarmLaunchedRun,
} from "@/components/swarms/new-swarm-running-step";
import {
  clearNewSwarmFlowDraft,
  readNewSwarmFlowDraft,
  saveNewSwarmFlowDraft,
} from "@/components/swarms/new-swarm-flow-draft";
import {
  DEFAULT_SWARM_INTENSITY,
  SWARM_INTENSITY_ORDER,
  SWARM_INTENSITY_PRESETS,
  estimateSwarmSessions,
  type SwarmPushIntensity,
} from "@/components/swarms/swarm-intensity";
import {
  SWARM_QUERIES,
  LaunchJourneyRunError,
  SwarmGenerateError,
  generateSwarmPersonaBatch,
} from "@/lib/swarm-api";
import {
  MAX_RUBRIC_CRITERIA,
  mergeRubrics,
  mintCriterionId,
  serializeRubricForWire,
} from "@/shared/journey-rubric";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";
import { useComputersEnabled } from "@/hooks/useComputersEnabled";
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";
import { useSkillsEnabled } from "@/hooks/useSkillsEnabled";
import { useHostList } from "@/hooks/useClients";
import { shouldQueryProjectId } from "@/hooks/useProjects";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";
import { usePreviewedEnvironmentId } from "@/hooks/use-previewed-environment-id";
import { useProjectServerAttachments } from "@/hooks/useViews";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import type { GoalJudgeConfig } from "@/components/shared/session-quality/judge-config";
import { track } from "@/lib/analytics";
import { toast } from "@/lib/toast";
import { ClusterTuningControl } from "@/components/shared/usage-insights/ClusterTuningControl";
import type { ClusterTuning } from "@/lib/cluster-tuning";
import { describeCloudServerBlock } from "@/lib/cloud-server-readiness";
import { environmentLabel } from "@/lib/environment-label";
import { ErrorCard } from "@/components/ui/error-card";
import { cn } from "@/lib/utils";

/**
 * The flow's four steps. `Done` is deliberately absent: a finished swarm is a
 * state of Findings, not a fifth circle that can never be current.
 */
const CREATE_STEPS = [
  { id: "describe", label: "Describe" },
  { id: "confirm", label: "Confirm personas" },
  { id: "running", label: "Running" },
  { id: "findings", label: "Findings" },
] as const;

/**
 * The prefilled Swarm name.
 *
 * The frame asks for a suggestion, and a date is the only honest one at first
 * paint: the name field sits ABOVE the description, so there is no user input
 * to derive a title from yet. Deriving it later would fight the user — the
 * field is editable and most people will rewrite it — so it is computed once
 * on mount and then left alone.
 */
export function suggestSwarmName(now: Date): string {
  const day = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(now);
  return `Swarm · ${day}`;
}

/** Backend cap on `swarms.name`. */
const SWARM_NAME_MAX = 120;

/**
 * The insight-grouping control is hidden in the create flow. The block is left
 * wired up rather than deleted — the project default it writes is still a real
 * setting, so this is a visibility switch, not a removal.
 */
const SHOW_INSIGHT_GROUPING: boolean = false;

// Prefixed with "e.g." on purpose: the un-prefixed sentence read as filled-in
// content, so users hit a disabled button with no idea the box was empty.
const DESCRIBE_PLACEHOLDER =
  "e.g. Finance ops reconciling payouts, and devs wiring up subscription billing.";

/** Concurrent launches. Bounded so a 60-journey launch doesn't open 60
 * simultaneous requests, while still finishing in seconds. */
const LAUNCH_CONCURRENCY = 4;

/** Below this, an elapsed counter is noise rather than reassurance. */
const ELAPSED_VISIBLE_AFTER_SECONDS = 3;
/** Past this, the wait is worth explaining rather than just counting. */
const SLOW_GENERATION_SECONDS = 30;

/**
 * What the Describe step says while it waits.
 *
 * A spinner alone is what made a slow generation read as a hang: the reporter's
 * "buffered for a while" was a working request with nothing to show for itself.
 * So the line names the STAGE (targets are resolved before the model is called,
 * and that stage can itself create environments), counts real elapsed seconds
 * rather than faking a progress bar, and after a while says the thing the user
 * actually needs to decide with — that leaving costs nothing, because the flow
 * writes no rows until Launch.
 *
 * No ETA is quoted: generation is one model call whose latency scales with the
 * environment's tool inventory, and a number we'd have to invent would be worse
 * than none.
 */
export function generationProgressLine(args: {
  stage: "targets" | "personas";
  elapsedSeconds: number;
  personaCount: number;
  journeyCount: number;
}): string {
  const { stage, elapsedSeconds, personaCount, journeyCount } = args;
  const what =
    stage === "targets"
      ? "Preparing targets: resolving the environments to generate against"
      : `Writing ${personaCount} ${
          personaCount === 1 ? "persona" : "personas"
        } with up to ${journeyCount} ${
          journeyCount === 1 ? "goal" : "goals"
        } each, grounded on the target's tools`;
  const elapsed =
    elapsedSeconds >= ELAPSED_VISIBLE_AFTER_SECONDS
      ? ` · ${elapsedSeconds}s elapsed`
      : "";
  const patience =
    elapsedSeconds >= SLOW_GENERATION_SECONDS
      ? " Still waiting on the generator — nothing is saved until you launch, so leaving and coming back costs nothing."
      : "";
  return `${what}${elapsed}.${patience}`;
}

/** Whole seconds since `since`, ticking while it is set. */
function useElapsedSeconds(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  if (since === null) return 0;
  return Math.max(0, Math.floor((now - since) / 1000));
}

export type CreateSwarmDraft = {
  name: string;
  description?: string;
  environmentIds?: string[];
  config: { sessionsPerTarget: number; maxTurns: number };
  judgeConfig?: GoalJudgeConfig;
  rubric?: ReturnType<typeof serializeRubricForWire>;
  idempotencyKey: string;
};

export type CreatePersonaDraft = {
  name: string;
  role: string;
  notes?: string;
  avatarShape: number;
  avatarPalette: number;
  idempotencyKey: string;
};

export type CreateJourneyDraft = {
  name?: string;
  goal: string;
  hostIds: string[];
  environmentIds: string[];
  config: { sessionsPerTarget: number; maxTurns: number };
  judgeConfig?: GoalJudgeConfig;
  rubric?: ReturnType<typeof serializeRubricForWire>;
  /** Authoring provenance — the swarm this journey is created in. */
  swarmRefId?: string;
  idempotencyKey: string;
};

type FlowPersona = ReusedPersona;

/**
 * Tool-count hint for the grounding line, isolated so an older backend without
 * the query (or an unresolvable environment) can't break the form — the parent
 * wraps this in an ErrorBoundary and simply renders no hint.
 */
function EnvironmentGroundingHint({
  projectId,
  environmentId,
}: {
  projectId: string;
  environmentId: string;
}) {
  const inventory = useQuery(
    SWARM_QUERIES.getEnvironmentToolInventory as any,
    { projectId, environmentId } as any
  ) as
    | {
        environmentName: string;
        serverCount: number;
        toolCount: number;
        capturedAt: number | null;
      }
    | null
    | undefined;

  // Absent, unresolvable, or nothing captured: say nothing. A "0 tools" line
  // reads as a failure the user has to act on, when the real answer is that
  // generation will fall back to describing the surface by name.
  if (!inventory || inventory.toolCount === 0) return null;
  return (
    <p className="text-sm leading-relaxed text-muted-foreground">
      Grounded on {inventory.toolCount}{" "}
      {inventory.toolCount === 1 ? "tool" : "tools"} from{" "}
      {inventory.environmentName}.
    </p>
  );
}

/**
 * Run `worker` over `items`, at most `limit` at a time, and STOP SCHEDULING
 * once `worker` reports the wave is doomed.
 *
 * The stop signal exists for one failure: an organization that hits its credit
 * limit. Every remaining launch in the wave will be rejected for exactly the
 * same reason, so firing them costs a round-trip each and produces N identical
 * banners. A worker returns `"stop"` and no further item is picked up.
 *
 * Requests ALREADY in flight are not cancelled here — a launch is a POST that
 * may have already created a durable run row, and aborting the client half
 * would leave one running with nobody watching. They are allowed to settle;
 * the caller deduplicates their errors so one billing message is shown, not
 * `limit` of them.
 */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void | "stop">
): Promise<void> {
  let cursor = 0;
  let stopped = false;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        if (stopped) return;
        const index = cursor;
        cursor += 1;
        if ((await worker(items[index])) === "stop") {
          stopped = true;
          return;
        }
      }
    }
  );
  await Promise.all(runners);
}

/**
 * Set equality over environment ids — order is irrelevant to what a run
 * executes, so a reordered-but-identical selection must not trigger an
 * override that says nothing.
 */
function sameEnvironmentSelection(
  stored: readonly string[] | null,
  selection: readonly string[]
): boolean {
  const current = stored ?? [];
  if (current.length !== selection.length) return false;
  const wanted = new Set(selection);
  return current.every((id) => wanted.has(id));
}

function errorMessageOf(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export function NewSwarmCreateFlow({
  projectId,
  environments,
  hostNameById,
  createEnvironment,
  personas,
  onCreateSwarm,
  onCreatePersona,
  onCreateJourney,
  onUpdateJourney,
  launchJourney,
  onCancel,
  onDone,
  onOpenSession,
  onSaveExistingPersona,
  onSetInsightsTuning,
}: {
  projectId: string;
  environments: ProjectEnvironmentView[] | undefined;
  /** Host id → display name for auto-naming materialized envs. */
  hostNameById: (hostId: string) => string;
  createEnvironment: CreateProjectEnvironmentFn;
  /** Existing project personas, for the reuse row. */
  personas: FlowPersona[] | undefined;
  /** Write the authoring container. Idempotent — a retry replays the row. */
  onCreateSwarm: (draft: CreateSwarmDraft) => Promise<string>;
  onCreatePersona: (draft: CreatePersonaDraft) => Promise<string>;
  onCreateJourney: (
    personaRefId: string,
    draft: CreateJourneyDraft
  ) => Promise<string>;
  /** Apply this swarm's promises to a REUSED journey before launch: the
   * Describe env selection (when its stored fan-out differs) and the merged
   * swarm rubric / authored judge. Every field is optional — only what
   * actually changed is sent. `journeys:updateJourney` under the hood. */
  onUpdateJourney: (
    journeyRefId: string,
    patch: {
      environmentIds?: string[];
      hostIds?: string[];
      rubric?: ReturnType<typeof serializeRubricForWire>;
      judgeConfig?: GoalJudgeConfig;
      /** Confirm edits a reused goal's text in place (BB-122). */
      goal?: string;
    }
  ) => Promise<void>;
  launchJourney: (
    journeyId: string,
    /**
     * `environmentIds` was MISSING here while the call site below passed it —
     * and type-checked anyway, because a conditional spread defeats excess
     * property checking. The per-run environment fan-out (which now also
     * carries the model matrix: two cells on one client differ only by their
     * environment id) was therefore invisible to this interface, one rename
     * away from being silently dropped.
     */
    opts?: { swarmRunGroupId?: string; environmentIds?: string[] }
  ) => Promise<
    { status: "launched"; runId?: string } | { status: "already_launching" }
  >;
  onCancel: () => void;
  /** Hands back a label per launched run so the sessions view can name the
   * groups after the persona and journey instead of a run id. */
  onDone: (runLabels: Map<string, string>) => void;
  /**
   * Follow a live finding to its evidence. `swarmRunGroupId` is this launch's
   * wave id, so the caller can send the user to the swarm's OWN page (the run's
   * durable home) rather than the flat Sessions list — the wizard's Running
   * step has no URL of its own, so that page is what makes leaving reversible.
   * `null` only when nothing has launched yet.
   */
  onOpenSession: (target: {
    sessionId: string;
    swarmRunGroupId: string | null;
    runLabels: Map<string, string>;
  }) => void;
  /** Leave create flow and open Personas for an existing persona. */
  /**
   * Persist an edit to an EXISTING persona from Confirm (BB-122).
   *
   * Unlike everything else in this flow, this writes before launch — the row
   * is already in the database and shared with every other swarm that reuses
   * it. That is why Confirm gates it behind an explicit Save rather than
   * mirroring keystrokes. `personas:updatePersona` under the hood.
   */
  onSaveExistingPersona: (
    personaRefId: string,
    patch: { name?: string; role?: string; notes?: string }
  ) => Promise<void>;
  /**
   * Save the project's clustering settings. Optional: absent hides the row, so
   * a surface on an older backend renders the flow unchanged rather than
   * offering a control whose mutation would be rejected.
   */
  onSetInsightsTuning?: (tuning: ClusterTuning) => Promise<void>;
}) {
  const skillsEnabled = useSkillsEnabled();
  const computersEnabled = useComputersEnabled();
  const environmentsEnabled = useProjectEnvironmentsEnabled();
  const resolveComposerTargets = useComposerResolver(projectId);
  const { isAuthenticated } = useConvexAuth();
  const isUserReady = useDbUserReady();
  const hostsQueryEnabled =
    isAuthenticated && shouldQueryProjectId(projectId);
  const attachmentsQueryEnabled =
    isAuthenticated && isUserReady && shouldQueryProjectId(projectId);
  const { hosts, isLoading: hostsLoading } = useHostList({
    isAuthenticated,
    projectId,
  });
  const { serverAttachments, isLoading: attachmentsLoading } =
    useProjectServerAttachments({ isAuthenticated, projectId });
  const [previewedHostId] = usePreviewedHostId(projectId);
  const [previewedEnvironmentId] = usePreviewedEnvironmentId(projectId);
  /**
   * The draft this mount is resuming, read ONCE so every initializer below sees
   * the same snapshot. Null on a genuine cold start.
   *
   * This flow is remounted for reasons the user did not ask for — the Swarms
   * route re-enters its "still deciding who you are" spinner whenever a Convex
   * websocket reconnect (returning to a backgrounded tab does one) makes the
   * membership query re-resolve — and a remount used to throw away a whole
   * generated slate. See `new-swarm-flow-draft.ts`.
   */
  const [restoredDraft] = useState(() => readNewSwarmFlowDraft(projectId));
  const [step, setStep] = useState<"describe" | "confirm" | "running">(
    restoredDraft?.step ?? "describe"
  );
  const [draft, setDraft] = useState(restoredDraft?.description ?? "");
  /**
   * Required, and prefilled — see {@link suggestSwarmName}. Computed once via
   * the lazy initializer so it does not change under the user on re-render.
   */
  const [swarmName, setSwarmName] = useState(
    // `||`, not `??`: a draft written before this field existed carries an
    // empty string, which should still fall back to the suggestion.
    () => restoredDraft?.name || suggestSwarmName(new Date())
  );
  /**
   * Whether the user has typed in the name field.
   *
   * `hasResumableWork` needs to tell an edited name from the untouched
   * suggestion — a bare non-empty check would mark every fresh form resumable
   * and leave a draft behind for a flow nobody started. Comparing against the
   * initial value cannot do it across a remount: the restored name IS the
   * initial value there, so an edited name read as untouched and its own draft
   * was cleared. So the fact is recorded, and travels with the draft.
   */
  const [nameEdited, setNameEdited] = useState(
    restoredDraft?.nameEdited === true
  );
  const [targetState, setTargetState] = useState<EnvironmentComposerState>(
    () => restoredDraft?.targetState ?? emptyComposerState()
  );
  /** One-shot auto-seed — never overwrite after the user clears or edits. */
  const targetSeededRef = useRef(false);
  /** Env ids after materialize (compose path). Cleared when the composer changes. */
  const [resolvedEnvironmentIds, setResolvedEnvironmentIds] = useState<
    string[] | null
  >(restoredDraft?.resolvedEnvironmentIds ?? null);
  const [resolvedEnvironments, setResolvedEnvironments] = useState<
    ProjectEnvironmentView[] | null
  >(restoredDraft?.resolvedEnvironments ?? null);
  /** Newly created envs may lag the live list query — keep them for payload/labels. */
  const [createdEnvOverlay, setCreatedEnvOverlay] = useState<
    ProjectEnvironmentView[]
  >(restoredDraft?.createdEnvOverlay ?? []);
  const [materializing, setMaterializing] = useState(false);
  /** "Add existing personas" popover. */
  const [personaPickerOpen, setPersonaPickerOpen] = useState(false);
  const [savingInsightsTuning, setSavingInsightsTuning] = useState(false);

  // The project's standing clustering settings. Only subscribed when the row
  // is actually rendered — an older backend without the query would otherwise
  // make every create flow subscribe to a function that does not exist, and
  // while the row is hidden there is nothing to feed.
  const insightsTuning = useQuery(
    SWARM_QUERIES.getSwarmInsightsTuning as any,
    SHOW_INSIGHT_GROUPING && onSetInsightsTuning
      ? ({ projectId } as any)
      : "skip"
  ) as { tuning: ClusterTuning; source: string } | null | undefined;

  const handleSaveInsightsTuning = useCallback(
    (tuning: ClusterTuning) => {
      if (!onSetInsightsTuning) return;
      setSavingInsightsTuning(true);
      void onSetInsightsTuning(tuning)
        .then(() => {
          toast.success("Insight grouping saved for this project");
        })
        .catch((error: unknown) => {
          toast.error(
            error instanceof Error
              ? error.message
              : "Could not save insight grouping."
          );
        })
        .finally(() => setSavingInsightsTuning(false));
    },
    [onSetInsightsTuning]
  );
  const [pushIntensity, setPushIntensity] = useState<SwarmPushIntensity>(
    restoredDraft?.pushIntensity ?? DEFAULT_SWARM_INTENSITY
  );
  const [reusedIds, setReusedIds] = useState<string[]>(
    restoredDraft?.reusedIds ?? []
  );
  const [proposed, setProposed] = useState<ProposedPersona[]>(
    restoredDraft?.proposed ?? []
  );
  const [launchedRuns, setLaunchedRuns] = useState<SwarmLaunchedRun[]>(
    restoredDraft?.launchedRuns ?? []
  );
  const [generating, setGenerating] = useState(false);
  /** When the in-flight generation started — drives the progress line. */
  const [generatingSince, setGeneratingSince] = useState<number | null>(null);
  const generationElapsedSeconds = useElapsedSeconds(generatingSince);
  const [launching, setLaunching] = useState(false);
  // A generation that was in flight when this flow was remounted cannot be
  // resumed: the request belonged to the unmounted component. Saying so beats
  // restoring a Describe step that looks like the user never pressed Continue.
  const [errorMessage, setErrorMessage] = useState<string | null>(
    restoredDraft?.generatingSince != null
      ? "Persona generation was interrupted when this view reloaded. Nothing was saved — press Continue to generate again."
      : null
  );
  // Sync latch: `generating`/`launching` are state, so two fast clicks in one
  // tick would both see the old value and fire twice.
  const inFlightRef = useRef(false);
  // Labels for Overview session grouping — set at launch, handed to onDone
  // when the user leaves Running (Cancel / Stop / Look now).
  const launchedRunLabelsRef = useRef<Map<string, string>>(
    new Map(restoredDraft?.runLabels ?? [])
  );
  // Rows a previous attempt already created. A launch failure leaves the user
  // on Confirm with a Retry, and without this the retry would create every
  // persona and journey a SECOND time — the rows are already real, only the
  // launch needs redoing.
  const persistedTargetsRef = useRef<LaunchTarget[] | null>(
    restoredDraft?.launch.targets ?? null
  );
  // Environments baked into those persisted journeys. If the user goes Back
  // and changes the env selection, retrying must NOT relaunch the old
  // single-client journeys while the matrix shows the new multi-client set.
  const persistedEnvironmentKeyRef = useRef<string | null>(
    restoredDraft?.launch.environmentKey ?? null
  );
  /**
   * The wave id for THIS swarm, minted once and reused across a retry.
   *
   * A partial failure leaves some journeys launched and some not; the retry
   * replays the launched ones' idempotency keys, and the backend returns the
   * runs it already created — stamped with the wave they were born into.
   * Minting a fresh id on retry would file the newly-succeeding runs under a
   * different wave and split one user-visible swarm across two rows in the
   * Overview.
   */
  const persistedRunGroupIdRef = useRef<string | null>(
    restoredDraft?.launch.runGroupId ?? null
  );
  /**
   * Stable prefix for this authoring session's idempotency keys.
   *
   * Every row the launch creates derives its key from this plus its own stable
   * local key, so a retry re-sends the SAME keys and the backend replays the
   * rows it already wrote instead of creating a second persona and journey per
   * proposal. Kept in the session draft alongside `persistedTargetsRef` so a
   * remount or reload between attempts resumes the same keys instead of
   * doubling every row.
   */
  const flowIdRef = useRef<string | null>(restoredDraft?.launch.flowId ?? null);
  /** The swarm row this launch created, so a retry doesn't create a second. */
  const persistedSwarmIdRef = useRef<string | null>(
    restoredDraft?.launch.swarmId ?? null
  );

  const envList = useMemo(() => environments ?? [], [environments]);

  useEffect(() => {
    if (targetSeededRef.current) return;
    // Wait until the queries that feed the seed have settled — but only when
    // those queries are actually enabled. A skipped host/attachment query
    // reports loading forever (`undefined`), which used to block seeding for
    // unauthenticated or transient-project opens.
    if (environmentsEnabled && environments === undefined) return;
    if (hostsQueryEnabled && hostsLoading) return;
    if (attachmentsQueryEnabled && attachmentsLoading) return;
    // Auth settled but DB user not ready yet — attachments are still skipped.
    // Seeding now would permanently miss the default server group.
    if (
      isAuthenticated &&
      shouldQueryProjectId(projectId) &&
      !isUserReady
    ) {
      return;
    }
    // Any non-empty stack or customized flag means the user already touched
    // the composer; do not overwrite a slot-only edit that landed before seed.
    if (
      targetState.customized ||
      targetState.environmentIds.length > 0 ||
      targetState.stack.hostIds.length > 0 ||
      targetState.stack.serverAttachmentId != null ||
      targetState.stack.skillSelection != null ||
      targetState.stack.computerEnvironmentId != null
    ) {
      targetSeededRef.current = true;
      return;
    }
    // If flag toggles off, don't carry forward stale environments from the prior state.
    const effectiveEnvList = environmentsEnabled ? envList : [];
    const next = defaultComposerState({
      environments: effectiveEnvList,
      hosts,
      preferredHostId: previewedHostId,
      preferredEnvironmentId: previewedEnvironmentId,
      serverAttachments,
      environmentsEnabled,
    });
    targetSeededRef.current = true;
    if (next) setTargetState(next);
  }, [
    attachmentsLoading,
    attachmentsQueryEnabled,
    envList,
    environments,
    environmentsEnabled,
    hosts,
    hostsLoading,
    hostsQueryEnabled,
    isAuthenticated,
    isUserReady,
    previewedEnvironmentId,
    previewedHostId,
    projectId,
    serverAttachments,
    targetState.customized,
    targetState.environmentIds.length,
    targetState.stack.computerEnvironmentId,
    targetState.stack.hostIds.length,
    targetState.stack.serverAttachmentId,
    targetState.stack.skillSelection,
  ]);

  const composeMode = isComposeMode(targetState);
  const targetCount = composerTargetCount(targetState);
  const environmentIds = useMemo(() => {
    if (resolvedEnvironmentIds) return resolvedEnvironmentIds;
    if (!composeMode) return targetState.environmentIds;
    return [];
  }, [composeMode, resolvedEnvironmentIds, targetState.environmentIds]);
  const envListForPayload = useMemo(() => {
    const byId = new Map(envList.map((e) => [e.environmentId, e]));
    for (const env of createdEnvOverlay) {
      byId.set(env.environmentId, env);
    }
    for (const env of resolvedEnvironments ?? []) {
      byId.set(env.environmentId, env);
    }
    return [...byId.values()];
  }, [createdEnvOverlay, envList, resolvedEnvironments]);

  /**
   * Identity of "where this swarm runs", used to invalidate the retry caches
   * below. It must cover EVERY field that changes what a target resolves to —
   * a field left out means editing it silently reuses journeys, a swarm row and
   * goals built for the old setup.
   *
   * Skill pins are in the key for exactly that reason. They are order-bearing at
   * resolve time (the resolver iterates them into `composeSkillChannels`), so
   * unlike the ids above they are NOT sorted.
   */
  const environmentSelectionKey = useMemo(
    () =>
      [
        composeMode ? "compose" : "castles",
        ...[...targetState.environmentIds].sort(),
        ...[...targetState.stack.hostIds].sort(),
        targetState.stack.serverAttachmentId ?? "",
        targetState.stack.computerEnvironmentId ?? "",
        `skills:${(targetState.stack.skillSelection?.skillIds ?? []).join(
          ","
        )}`,
        targetState.customized ? "custom" : "seeded",
      ].join("|"),
    [composeMode, targetState]
  );

  // A restored draft already carries the resolution for the selection key it
  // was saved with, so the mount pass of this reset would throw away work the
  // draft exists to keep.
  const skipResolvedResetRef = useRef(restoredDraft !== null);
  useEffect(() => {
    if (skipResolvedResetRef.current) {
      skipResolvedResetRef.current = false;
      return;
    }
    setResolvedEnvironmentIds(null);
    setResolvedEnvironments(null);
  }, [environmentSelectionKey]);

  useEffect(() => {
    // Drop the retry cache whenever the env selection diverges from what those
    // journeys were created with — including the case where an older attempt
    // cached targets without recording an env key (null ≠ "a|b").
    if (persistedTargetsRef.current == null) return;
    if (persistedEnvironmentKeyRef.current === environmentSelectionKey) return;
    persistedTargetsRef.current = null;
    persistedEnvironmentKeyRef.current = null;
    // Those rows are no longer the ones we'd relaunch, so the wave they were
    // going to join is void too — the next attempt is a genuinely new swarm.
    persistedRunGroupIdRef.current = null;
    persistedSwarmIdRef.current = null;
    flowIdRef.current = null;
  }, [environmentSelectionKey]);
  const personaList = useMemo(() => personas ?? [], [personas]);
  const preset = SWARM_INTENSITY_PRESETS[pushIntensity];
  const reusedPersonas = useMemo(
    () => personaList.filter((persona) => reusedIds.includes(persona._id)),
    [personaList, reusedIds]
  );

  const hasGenerateTargets =
    (!composeMode && targetState.environmentIds.length > 0) ||
    (composeMode && targetState.stack.hostIds.length > 0);

  /**
   * Swarm sessions run in MCPJam's cloud, so a target whose servers are absent
   * or unreachable from there cannot produce a run — the resolver rejects it
   * with `ENV_NO_SERVERS`, and only AFTER this flow has written personas, goals
   * and (in compose mode) an ad-hoc environment row. Blocking here keeps that
   * failure in front of the pickers that fix it. `null` = nothing measurable is
   * wrong; the resolver stays the backstop for what we cannot see.
   */
  const serverReadiness = useCloudServerReadiness({
    projectId,
    state: targetState,
    environments: envList,
  });
  const serverBlock = describeCloudServerBlock(serverReadiness);

  // Generating and reusing are two independent doors into Confirm, and they
  // compose. Writing anything in the box asks for a generation (which needs
  // targets to ground on); selecting personas alone is a complete swarm on
  // its own — those journeys carry their own environments, so requiring one
  // here would block a returning user over a field their run never reads.
  const wantsGenerate = draft.trim().length > 0;
  const canGenerate =
    wantsGenerate && hasGenerateTargets && !generating && !materializing;
  const hasSwarmName = swarmName.trim().length > 0;
  const canContinue =
    generating || materializing || serverBlock !== null || !hasSwarmName
      ? false
      : wantsGenerate
      ? canGenerate
      : reusedIds.length > 0;

  /** Why the primary button is disabled, or a short summary when it isn't. */
  const continueHint = (() => {
    if (generating || materializing) return null;
    if (!canContinue) {
      // The notice above carries the finding and the fix; repeating it here
      // would put the same two sentences on screen twice.
      if (serverBlock) return "Fix where it runs to continue.";
      if (!hasSwarmName) return "Name this swarm to continue.";
      if (wantsGenerate) {
        return environmentsEnabled
          ? "Pick an environment or clients to generate against."
          : "Pick clients to generate against.";
      }
      if (personaList.length > 0) {
        // Hidden on purpose — the copy is kept here rather than deleted so it
        // can be switched back on:
        // "Describe your users, or pick a persona you already have."
        return null;
      }
      return "Describe your users to continue.";
    }
    const reused = reusedIds.length;
    const fresh = preset.personaCount;
    if (wantsGenerate && reused > 0) {
      return `${reused} existing · ${fresh} new on next step`;
    }
    if (wantsGenerate) {
      return `${fresh} new ${
        fresh === 1 ? "persona" : "personas"
      } on next step`;
    }
    return `${reused} ${reused === 1 ? "persona" : "personas"} selected`;
  })();

  const materializeArgs = useCallback(
    () => ({
      projectId,
      // The same source `SwarmTargetComposer` gets as `draftNameHint`. Built
      // from the description, one setup landed under two different names
      // depending on whether the user saved a draft or let launch materialize
      // it — and a prose paragraph is a poor environment name either way.
      stackName: swarmName.trim() || draft.trim() || "Swarm setup",
      legos: targetState.stack,
      hostName: hostNameById,
      liveEnvironments: envList,
      createEnvironment,
      skillsEnabled,
      computersEnabled,
    }),
    [
      computersEnabled,
      createEnvironment,
      draft,
      envList,
      hostNameById,
      projectId,
      skillsEnabled,
      swarmName,
      targetState.stack,
    ]
  );

  /**
   * Composer state → real `environmentIds` (plus the compat `hostIds` the
   * journey payload still carries).
   *
   * Ad-hoc rows are the path: the backend fingerprints the composition, so
   * relaunching the same setup reuses one unnamed row instead of naming a new
   * one after whatever the user typed in Describe. Two deployments can't do that
   * — one where the flag is off, one whose backend predates the mutation — and
   * both fall back to the legacy naming materializer for a release.
   */
  const resolveTargets = useCallback(async () => {
    const liveWithOverlay = (() => {
      const byId = new Map(envList.map((e) => [e.environmentId, e]));
      for (const env of createdEnvOverlay) {
        byId.set(env.environmentId, env);
      }
      return [...byId.values()];
    })();

    const legacyResolve = () =>
      resolveSwarmJourneyPayload({
        compose: composeMode,
        castleIds: targetState.environmentIds,
        legos: targetState.stack,
        liveEnvironments: liveWithOverlay,
        materialize: {
          ...materializeArgs(),
          liveEnvironments: liveWithOverlay,
        },
      });

    /**
     * Ad-hoc rows are minted UNCONDITIONALLY — `project-environments-enabled`
     * is not consulted here, and reading it was the bug.
     *
     * The backend draws the line between substrate and product, not between
     * flagged and unflagged orgs: `ensureAdhocEnvironments` carries no
     * environments gate ("launch-path substrate"), while `createEnvironment`,
     * which mints a NAMED row, does. Gating this branch on the flag therefore
     * inverted the protection — an org with Swarms but not Environments
     * skipped the ungated path and fell back to the legacy naming
     * materializer, the one mutation its backend refuses ("Environments is not
     * currently available for your organization"). With no saved environments
     * to pick either, that org could not launch a swarm at all.
     *
     * Rows such an org cannot see in `/environments` are the intended shape of
     * an ad-hoc row, not a leak: unnamed, fingerprint-deduped so relaunching a
     * setup reuses one row instead of accumulating them, and already minted
     * for these same orgs by User Testing, which never gated this call.
     *
     * Whether the BACKEND can mint stays a per-call question, answered by
     * `isAdhocUnavailable` from the deployment actually being talked to.
     */
    let resolved: Awaited<ReturnType<typeof legacyResolve>> = null;
    try {
      const composed = await resolveComposerTargets({
        state: targetState,
        liveEnvironments: liveWithOverlay,
        max: MAX_ENVIRONMENTS_PER_JOURNEY,
      });
      const payload = buildEnvJourneyPayload(
        composed.environmentIds,
        composed.environments
      );
      resolved = payload
        ? {
            ...payload,
            environments: composed.environments,
            materialized: {
              environmentIds: composed.environmentIds,
              environments: composed.environments,
              createdIds: composed.createdIds,
              reusedIds: composed.reusedIds,
            },
          }
        : null;
    } catch (err) {
      // An old backend is the one failure worth retrying differently; every
      // other rejection is the user's to read.
      if (!isAdhocUnavailable(err)) throw err;
      resolved = await legacyResolve();
    }

    if (!resolved) return null;
    setResolvedEnvironmentIds(resolved.environmentIds);
    setResolvedEnvironments(resolved.environments);
    if (resolved.materialized?.createdIds.length) {
      const created = resolved.environments.filter((env) =>
        resolved.materialized!.createdIds.includes(env.environmentId)
      );
      setCreatedEnvOverlay((prev) => {
        const byId = new Map(prev.map((e) => [e.environmentId, e]));
        for (const env of created) byId.set(env.environmentId, env);
        return [...byId.values()];
      });
    }
    return resolved;
  }, [
    composeMode,
    createdEnvOverlay,
    envList,
    materializeArgs,
    resolveComposerTargets,
    targetState,
  ]);

  const handleGenerate = useCallback(async () => {
    if (!canGenerate || inFlightRef.current) return;
    inFlightRef.current = true;
    setGenerating(true);
    setGeneratingSince(Date.now());
    setErrorMessage(null);
    track("swarm_create_generate_started", {
      location: "swarms",
      intensity: pushIntensity,
      personaCount: preset.personaCount,
      reusedPersonas: reusedIds.length,
    });
    try {
      setMaterializing(true);
      const resolved = await resolveTargets();
      setMaterializing(false);
      const groundingEnvironmentId = resolved?.environmentIds[0];
      if (!groundingEnvironmentId) {
        throw new Error(
          composeMode
            ? "Could not create environments from the selected clients."
            : "Pick an environment to generate against."
        );
      }
      const result = await generateSwarmPersonaBatch({
        projectId,
        environmentId: groundingEnvironmentId,
        personaCount: preset.personaCount,
        journeyCount: preset.journeyCount,
        description: draft.trim(),
        // Dedup hints: the slate is told what the project already has so a
        // returning user doesn't get near-copies of their own personas.
        ...(reusedPersonas.length > 0
          ? {
              existingPersonas: reusedPersonas.map((persona) => ({
                name: persona.name,
                role: persona.role,
              })),
            }
          : {}),
      });
      if (result.personas.length === 0) {
        throw new Error(
          "Generation returned no personas. Try again, or make sure the environment's servers have been connected so their tools are inspected."
        );
      }
      // A fresh slate is a fresh set of rows to create — drop any memory of
      // what a previous attempt persisted.
      persistedTargetsRef.current = null;
      persistedEnvironmentKeyRef.current = null;
      persistedRunGroupIdRef.current = null;
      persistedSwarmIdRef.current = null;
      flowIdRef.current = null;
      // Avatar looks are minted NOW, not at persist time, so the Confirm
      // preview shows the look the persona will actually be saved with.
      setProposed(
        result.personas.map((entry, personaIndex) => ({
          key: `persona-${personaIndex}-${entry.persona.name}`,
          name: entry.persona.name,
          role: entry.persona.role,
          ...(entry.persona.notes ? { notes: entry.persona.notes } : {}),
          ...mintPersonaAvatarLook(),
          journeys: entry.journeys.map((journey, journeyIndex) => ({
            key: `journey-${personaIndex}-${journeyIndex}`,
            ...(journey.name ? { name: journey.name } : {}),
            goal: journey.goal,
            // Criterion ids are minted at the same moment as the journey key,
            // so the row the user sees (and prunes) on Confirm is the row the
            // launch stamps — not a lookalike with a fresh id. The label makes
            // the scorecard read "Calls export_png" instead of the formatted
            // predicate's mouthful.
            ...(journey.suggestedChecks?.length
              ? {
                  checks: journey.suggestedChecks.map((predicate) => ({
                    id: mintCriterionId(),
                    label: `Calls ${predicate.toolName}`,
                    predicate,
                  })),
                }
              : {}),
          })),
        }))
      );
      track("swarm_create_generate_completed", {
        location: "swarms",
        personasRequested: preset.personaCount,
        personasReturned: result.personas.length,
      });
      setStep("confirm");
    } catch (err) {
      setMaterializing(false);
      setErrorMessage(
        err instanceof SwarmTargetMaterializeError ||
          err instanceof ComposerResolveError ||
          err instanceof SwarmGenerateError
          ? err.message
          : errorMessageOf(err, "Failed to generate personas.")
      );
    } finally {
      inFlightRef.current = false;
      setGenerating(false);
      setGeneratingSince(null);
    }
  }, [
    canGenerate,
    composeMode,
    draft,
    preset,
    projectId,
    pushIntensity,
    resolveTargets,
    reusedIds.length,
    reusedPersonas,
  ]);

  /**
   * The one primary action. Generation is NOT the only door into Confirm: a
   * reuse-only swarm skips it entirely, so a returning user reaches the launch
   * screen without writing a description or paying for a slate they didn't
   * ask for.
   */
  const handleContinue = useCallback(() => {
    if (!canContinue) return;
    if (wantsGenerate) {
      void handleGenerate();
      return;
    }
    persistedTargetsRef.current = null;
    persistedRunGroupIdRef.current = null;
    persistedSwarmIdRef.current = null;
    flowIdRef.current = null;
    setProposed([]);
    setErrorMessage(null);
    setStep("confirm");
  }, [canContinue, handleGenerate, wantsGenerate]);

  const handleLaunch = useCallback(
    async (payload: ConfirmLaunchPayload) => {
      if (inFlightRef.current) return;
      // Pre-check the project cap BEFORE any write: a full project would
      // otherwise fail partway through, leaving some personas created.
      if (personaList.length + proposed.length > MAX_PERSONAS_PER_PROJECT) {
        setErrorMessage(
          `This project is at its limit of ${MAX_PERSONAS_PER_PROJECT} personas. Delete some before creating ${proposed.length} more.`
        );
        return;
      }

      let envPayload: { environmentIds: string[]; hostIds: string[] } | null =
        null;
      if (
        proposed.length > 0 ||
        composeMode ||
        targetState.environmentIds.length > 0
      ) {
        try {
          const resolved = await resolveTargets();
          envPayload = resolved
            ? {
                environmentIds: resolved.environmentIds,
                hostIds: resolved.hostIds,
              }
            : null;
        } catch (err) {
          setErrorMessage(
            err instanceof SwarmTargetMaterializeError ||
              err instanceof ComposerResolveError
              ? err.message
              : errorMessageOf(
                  err,
                  "Could not resolve environments for launch."
                )
          );
          return;
        }
      }
      if (!envPayload && proposed.length > 0) {
        setErrorMessage(
          "The selected environments can't be resolved to hosts. Go back and pick an environment or clients with a compatible host."
        );
        return;
      }

      inFlightRef.current = true;
      setLaunching(true);
      setErrorMessage(null);

      let firstError: string | null = null;
      /**
       * Set when a launch came back 402. Distinct from `firstError` because it
       * changes what the summary SAYS: "some runs were rejected" is advice to
       * retry, and retrying a credit limit cannot work.
       */
      let billingBlocked = false;
      /**
       * The 402's own message, kept SEPARATE from `firstError`. The billing
       * summary has to state the hard stop, and `firstError` may already hold
       * an unrelated transient failure that settled first — rendering that one
       * under "Launched N of M" is precisely the retry-this advice the billing
       * branch exists to avoid.
       */
      let billingError: string | null = null;
      let targets: LaunchTarget[] = [];
      let launched = 0;
      const runLabels = new Map<string, string>();
      const launchedBatch: SwarmLaunchedRun[] = [];

      // Minted OUTSIDE the retry branch below: a retry has to reuse the wave
      // the first attempt's runs were stamped with, or one swarm lands as two
      // rows in the Overview.
      persistedRunGroupIdRef.current ??= crypto.randomUUID();
      const swarmRunGroupId = persistedRunGroupIdRef.current;
      // Same reason, same placement: keys derived from this must be identical
      // across a retry or the backend can't recognise the replay.
      flowIdRef.current ??= crypto.randomUUID();
      const flowId = flowIdRef.current;

      // Every exit from here has to clear the latch. Without the finally, an
      // unexpected throw would leave the button spinning on "Creating &
      // launching…" with Cancel disabled — the user's only escape a reload.
      try {
        // The authoring container, written ONCE per launch and — critically —
        // OUTSIDE the retry branch below. That branch is skipped wholesale on a
        // retry, so anything placed inside it never runs on the attempt that
        // actually succeeds. Idempotent, so a retry replays the same row.
        if (!persistedSwarmIdRef.current) {
          try {
            persistedSwarmIdRef.current = await onCreateSwarm({
              // The Describe step's own required field, trimmed to the
              // backend's cap. The fallbacks are belt-and-braces: Continue is
              // gated on a non-empty name, so neither should be reachable.
              name:
                swarmName.trim().slice(0, SWARM_NAME_MAX) ||
                draft.trim().slice(0, SWARM_NAME_MAX) ||
                "Swarm",
              ...(draft.trim() ? { description: draft.trim() } : {}),
              ...(envPayload?.environmentIds.length
                ? { environmentIds: envPayload.environmentIds }
                : {}),
              config: {
                sessionsPerTarget: preset.sessionsPerTarget,
                maxTurns: preset.maxTurns,
              },
              ...(payload.judgeConfig
                ? { judgeConfig: payload.judgeConfig }
                : {}),
              ...(payload.rubric.length > 0
                ? { rubric: serializeRubricForWire(payload.rubric) }
                : {}),
              idempotencyKey: `${flowId}:swarm`,
            });
          } catch (err) {
            // Provenance, not execution: a swarm row we couldn't write is not
            // a reason to refuse to launch the runs the user asked for. The
            // journeys are simply created without a container.
            firstError ??= errorMessageOf(
              err,
              "The swarm record could not be created."
            );
          }
        }
        const swarmRefId = persistedSwarmIdRef.current;

        if (persistedTargetsRef.current) {
          targets = persistedTargetsRef.current;
        } else {
          // Reused journeys get this swarm's GRADING merged into their own
          // rubric — additive, structurally deduped, so existing criterion ids
          // (and their cross-run trends) survive and relaunching is
          // idempotent. Shared ids across journeys are what let Findings roll a
          // criterion up across the whole swarm; a reused journey graded on its
          // own rubric alone would silently sit outside every rollup.
          //
          // Their ENVIRONMENTS are deliberately NOT rewritten. The Describe
          // selection applies to this launch only, and it now rides as a run
          // parameter (`environmentIds` on launch) instead of being stamped
          // onto the definition. Rewriting a shared journey's stored fan-out to
          // satisfy one launch changed it for every future run and for everyone
          // else — a run parameter masquerading as a definition edit.
          const existingRubricByJourney = new Map(
            payload.reusedGrading.map((row) => [
              row.journeyId,
              row.existingRubric,
            ])
          );

          for (const target of payload.reusedTargets) {
            const patch: {
              rubric?: ReturnType<typeof serializeRubricForWire>;
              judgeConfig?: GoalJudgeConfig;
            } = {};

            if (payload.rubric.length > 0) {
              const existing = existingRubricByJourney.get(target.journeyId);
              // Absent grading means Confirm never resolved this journey's
              // rubric. Merging against `[]` would REPLACE the author's
              // criteria with the swarm's — skip instead of guessing.
              if (existing) {
                const merged = mergeRubrics(existing, payload.rubric);
                // `mergeRubrics` only ever appends, so an unchanged length is
                // an exact no-op test — and it can't be fooled by label
                // normalization the way comparing serialized rows would be.
                if (merged.length !== existing.length) {
                  patch.rubric = serializeRubricForWire(merged);
                }
              }
            }

            // Only when the author set one. Absent must leave the journey's
            // own judge alone, and `null` would CLEAR it.
            if (payload.judgeConfig) patch.judgeConfig = payload.judgeConfig;

            if (Object.keys(patch).length > 0) {
              try {
                await onUpdateJourney(target.journeyId, patch);
              } catch (err) {
                firstError ??= errorMessageOf(
                  err,
                  "A reused goal could not be updated for this swarm."
                );
                // Only grading can fail here now, and grading is advisory: the
                // run is still the one the user asked for, so it goes ahead
                // ungraded rather than being dropped. (The environment
                // selection can no longer fail at this point — it is applied at
                // launch, where a rejection fails that launch loudly.)
              }
            }
            targets.push(target);
          }

          for (const persona of proposed) {
            const journeys = persona.journeys.filter((journey) =>
              journey.goal.trim()
            );
            // Draft rows with blank goals are authoring placeholders — skip
            // the whole persona rather than create an empty shell.
            if (journeys.length === 0) continue;

            let personaRefId: string;
            try {
              personaRefId = await onCreatePersona({
                name: persona.name,
                role: persona.role,
                ...(persona.notes ? { notes: persona.notes } : {}),
                avatarShape: persona.avatarShape,
                avatarPalette: persona.avatarPalette,
                // `persona.key` is the stable local id these proposals were
                // minted with, so a retry derives the SAME key and replays the
                // row instead of creating a near-identical twin.
                idempotencyKey: `${flowId}:persona:${persona.key}`,
              });
            } catch (err) {
              firstError ??= errorMessageOf(
                err,
                "A persona could not be created."
              );
              continue;
            }
            for (const journey of journeys) {
              // The swarm-level rubric is stamped onto every journey (shared
              // ids are what let Findings roll a criterion up across the
              // swarm); the journey's own suggested checks ride on top of it,
              // stamped onto THIS journey only — a check about the export
              // tool must never drag down the pass rate of a journey that
              // would never call it.
              const criteria = [
                ...payload.rubric,
                ...(journey.checks ?? []),
              ].slice(0, MAX_RUBRIC_CRITERIA);
              const rubricWire =
                criteria.length > 0
                  ? serializeRubricForWire(criteria)
                  : undefined;
              try {
                const journeyId = await onCreateJourney(personaRefId, {
                  ...(journey.name ? { name: journey.name } : {}),
                  goal: journey.goal,
                  hostIds: envPayload!.hostIds,
                  environmentIds: envPayload!.environmentIds,
                  config: {
                    sessionsPerTarget: preset.sessionsPerTarget,
                    maxTurns: preset.maxTurns,
                  },
                  ...(payload.judgeConfig
                    ? { judgeConfig: payload.judgeConfig }
                    : {}),
                  // Empty ⇒ omit, never `[]`: a stored empty rubric reads as
                  // "graded against nothing" rather than ungraded.
                  ...(rubricWire ? { rubric: rubricWire } : {}),
                  ...(swarmRefId ? { swarmRefId } : {}),
                  idempotencyKey: `${flowId}:journey:${persona.key}:${journey.key}`,
                });
                targets.push({
                  journeyId,
                  label: `${persona.name} · ${
                    journey.name?.trim() || journey.goal.slice(0, 40)
                  }`,
                  personaId: personaRefId,
                  personaName: persona.name,
                  personaRole: persona.role,
                  avatarShape: persona.avatarShape,
                  avatarPalette: persona.avatarPalette,
                });
              } catch (err) {
                firstError ??= errorMessageOf(
                  err,
                  "A goal could not be created."
                );
              }
            }
          }
          // Remember what landed so a retry only re-launches. Skipped when
          // nothing was created — there the rows genuinely don't exist yet and
          // retrying creation is the right behavior. Tie the cache to the env
          // selection so adding Cursor later can't relaunch Excal-only rows.
          if (targets.length > 0) {
            persistedTargetsRef.current = targets;
            persistedEnvironmentKeyRef.current = environmentSelectionKey;
          }
        }

        await runWithConcurrency(
          targets,
          LAUNCH_CONCURRENCY,
          async (target) => {
            try {
              const result = await launchJourney(target.journeyId, {
                swarmRunGroupId,
                // The Describe selection, applied to THIS run only. Sent for
                // reused journeys whose stored fan-out differs from it —
                // journeys created above are already born with the selection,
                // so an override would be a no-op restating their own config.
                //
                // `target.environmentIds === undefined` marks a
                // just-created target; `null` marks a reused legacy journey
                // with no stored fan-out, which DOES need the override.
                ...(envPayload &&
                target.environmentIds !== undefined &&
                !sameEnvironmentSelection(
                  target.environmentIds,
                  envPayload.environmentIds
                )
                  ? { environmentIds: envPayload.environmentIds }
                  : {}),
              });
              if (result.status === "launched") {
                launched += 1;
                if (result.runId) {
                  runLabels.set(result.runId, target.label);
                  launchedBatch.push({
                    runId: result.runId,
                    journeyId: target.journeyId,
                    personaId: target.personaId,
                    personaName: target.personaName,
                    personaRole: target.personaRole,
                    ...(target.avatarShape !== undefined
                      ? { avatarShape: target.avatarShape }
                      : {}),
                    ...(target.avatarPalette !== undefined
                      ? { avatarPalette: target.avatarPalette }
                      : {}),
                    label: target.label,
                  });
                }
              }
            } catch (err) {
              // BILLING is terminal for the WHOLE wave, not for this target.
              // Every sibling would be rejected identically, so stop
              // scheduling and report the limit ONCE — `firstError` already
              // deduplicates the message for the launches that were in flight
              // when the first 402 came back.
              if (err instanceof LaunchJourneyRunError && err.status === 402) {
                billingBlocked = true;
                // Recorded on its OWN slot so the billing summary always says
                // "credit limit" even when an unrelated failure settled first,
                // and `??=` on both so each keeps the earliest of its kind.
                // `firstError` still gets it as a fallback: when the 402 is the
                // only failure and nothing launched, it is the whole story.
                billingError ??= err.message;
                firstError ??= err.message;
                return "stop";
              }
              firstError ??= errorMessageOf(
                err,
                "A run could not be launched."
              );
            }
            return undefined;
          }
        );
      } catch (err) {
        firstError ??= errorMessageOf(err, "The swarm could not be launched.");
      } finally {
        inFlightRef.current = false;
        setLaunching(false);
      }

      track("swarm_create_launched", {
        location: "swarms",
        journeys: targets.length,
        runs: launched,
        intensity: pushIntensity,
      });

      if (launched === 0 || launchedBatch.length === 0) {
        // Nothing is running, so leaving the flow would strand the user on an
        // empty view with no explanation. Rows that DID land are real, and the
        // copy has to say so — otherwise Retry looks like it will re-create
        // them.
        const created = persistedTargetsRef.current?.length ?? 0;
        setErrorMessage(
          `No runs were launched. ${
            firstError ?? "The launch requests were rejected."
          }` +
            (created > 0
              ? ` The ${
                  created === 1 ? "goal was" : `${created} goals were`
                } created — retrying only launches ${
                  created === 1 ? "it" : "them"
                }.`
              : "")
        );
        return;
      }
      if (launched === targets.length) {
        toast.success(
          `Launched ${launched} ${launched === 1 ? "run" : "runs"}`
        );
      } else if (billingBlocked) {
        // ONE billing message for the whole wave. The count matters here in a
        // way it doesn't for other partial failures: the remaining runs were
        // never attempted, so "N of M" would read as M-N transient failures
        // to retry rather than as a hard stop.
        toast.warning(
          `Launched ${launched} of ${targets.length} runs — ${
            billingError ?? "the organization's credit limit was reached."
          }`
        );
      } else {
        toast.warning(`Launched ${launched} of ${targets.length} runs`);
      }
      // Stay in the wizard on Running — Overview gets the runs when the user
      // leaves. Labels are handed off then so session grouping still names them.
      launchedRunLabelsRef.current = runLabels;
      setLaunchedRuns(launchedBatch);
      setStep("running");
    },
    [
      composeMode,
      environmentSelectionKey,
      launchJourney,
      onCreateJourney,
      onCreatePersona,
      onUpdateJourney,
      personaList.length,
      preset,
      proposed,
      pushIntensity,
      resolveTargets,
      targetState.environmentIds.length,
    ]
  );

  /**
   * Nothing resumable yet: an untouched Describe step must not leave a draft
   * behind, and must clear a previous one — otherwise the next remount would
   * resurrect a flow the user has since abandoned in place.
   */
  const hasResumableWork =
    step !== "describe" ||
    nameEdited ||
    draft.trim().length > 0 ||
    reusedIds.length > 0 ||
    proposed.length > 0 ||
    launchedRuns.length > 0 ||
    generatingSince !== null ||
    targetState.environmentIds.length > 0 ||
    targetState.stack.hostIds.length > 0;

  /**
   * Mirror the resumable flow into session storage on every change, so a
   * remount picks up where the user was instead of at Describe.
   *
   * The retry-identity refs are READ here rather than tracked as deps: each is
   * assigned immediately before the state update that lands in the same commit
   * (a launch sets them, then `setStep("running")`), so this write always sees
   * the current values.
   */
  useEffect(() => {
    if (!hasResumableWork) {
      clearNewSwarmFlowDraft();
      return;
    }
    saveNewSwarmFlowDraft(projectId, {
      step,
      name: swarmName,
      nameEdited,
      description: draft,
      targetState,
      resolvedEnvironmentIds,
      resolvedEnvironments,
      createdEnvOverlay,
      pushIntensity,
      reusedIds,
      proposed,
      launchedRuns,
      runLabels: [...launchedRunLabelsRef.current.entries()],
      generatingSince,
      launch: {
        flowId: flowIdRef.current,
        swarmId: persistedSwarmIdRef.current,
        runGroupId: persistedRunGroupIdRef.current,
        targets: persistedTargetsRef.current,
        environmentKey: persistedEnvironmentKeyRef.current,
      },
    });
  }, [
    createdEnvOverlay,
    draft,
    generatingSince,
    hasResumableWork,
    nameEdited,
    launchedRuns,
    projectId,
    proposed,
    pushIntensity,
    resolvedEnvironmentIds,
    resolvedEnvironments,
    reusedIds,
    step,
    swarmName,
    targetState,
  ]);

  /** Leaving the flow ends it — the draft is for remounts, not for history. */
  const leaveFlow = useCallback(() => {
    clearNewSwarmFlowDraft();
    onCancel();
  }, [onCancel]);

  const leaveRunning = useCallback(() => {
    clearNewSwarmFlowDraft();
    onDone(launchedRunLabelsRef.current);
  }, [onDone]);

  // Labels ride along exactly as they do on `leaveRunning`: this is a leave
  // too, so the Sessions grouping must still be able to name the runs.
  const openRunningSession = useCallback(
    (sessionId: string) => {
      onOpenSession({
        sessionId,
        swarmRunGroupId: persistedRunGroupIdRef.current,
        runLabels: launchedRunLabelsRef.current,
      });
    },
    [onOpenSession]
  );

  const activeStepIndex = step === "describe" ? 0 : step === "confirm" ? 1 : 2;

  const goToStep = useCallback(
    (index: number) => {
      if (launching || generating || materializing) return;
      // Once runs are live, don't rewind to Confirm (they'd re-launch).
      // Findings isn't built yet — only prior authoring steps are clickable.
      if (step === "running") return;
      if (index >= activeStepIndex) return;
      if (index === 0) {
        setErrorMessage(null);
        setStep("describe");
      }
    },
    [activeStepIndex, generating, launching, materializing, step]
  );

  /**
   * Which steps the stepper offers as a way back. "Already visited" is not the
   * same as "safe to revisit": rewinding out of Running would re-launch the
   * runs, and Findings is not built, so only earlier authoring steps qualify.
   */
  const canReturnToStep = useCallback(
    (index: number) => {
      if (launching || generating || materializing) return false;
      if (step === "running") return false;
      return index < activeStepIndex;
    },
    [activeStepIndex, generating, launching, materializing, step]
  );

  /**
   * Back link + stepper, built once and placed by whichever step renders it.
   * Describe and Confirm each own their own centered column, so the header has
   * to sit inside that column to line up with the form — which rules out a
   * full-width bar above them.
   */
  const flowHeader = (
    <>
      <button
        type="button"
        onClick={leaveFlow}
        className="flex w-fit items-center gap-1 text-sm font-medium text-primary hover:underline"
        data-testid="new-swarm-back-to-swarms"
      >
        <ChevronLeft className="size-3.5" />
        Swarms
      </button>
      <ProgressStepper
        steps={CREATE_STEPS}
        activeIndex={activeStepIndex}
        onStepSelect={goToStep}
        isStepSelectable={canReturnToStep}
        ariaLabel="New swarm progress"
        testId="new-swarm-progress"
      />
    </>
  );

  const runningFallbackColumns = useMemo(() => {
    return environmentIds.flatMap((environmentId) => {
      const env = envListForPayload.find(
        (entry) => entry.environmentId === environmentId
      );
      if (!env) return [];
      return [
        {
          key: `environment:${environmentId}`,
          label: environmentLabel(env, { hostName: hostNameById }),
        },
      ];
    });
  }, [envListForPayload, environmentIds, hostNameById]);

  const environmentLabels = useMemo(
    () =>
      environmentIds.map((environmentId) => {
        const env = envListForPayload.find(
          (entry) => entry.environmentId === environmentId
        );
        // `slice(0, 8)` stays for a row that isn't in the list AT ALL — a
        // different failure from a row that merely has no name, which
        // `environmentLabel` covers with the client name.
        return env
          ? environmentLabel(env, { hostName: hostNameById })
          : environmentId.slice(0, 8);
      }),
    [envListForPayload, environmentIds, hostNameById]
  );

  const groundingEnvironmentId =
    environmentIds[0] ?? targetState.environmentIds[0] ?? null;

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="new-swarm-create-flow"
    >
      {/* Describe and Confirm carry `flowHeader` inside their own column, so
          this bar is Running's alone: it is not redesigned yet, and its own
          footer Leave sits far down a streaming matrix. */}
      {step === "running" ? (
        <div className="shrink-0 border-b border-border/60 bg-muted/15 px-4 py-2.5 sm:px-6">
          <div className="flex min-w-0 items-center gap-4">
            <ProgressStepper
              steps={CREATE_STEPS}
              activeIndex={activeStepIndex}
              onStepSelect={goToStep}
              isStepSelectable={canReturnToStep}
              ariaLabel="New swarm progress"
              className="min-w-0 flex-1"
              testId="new-swarm-progress"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="shrink-0"
              disabled={launching}
              onClick={leaveRunning}
            >
              Leave
            </Button>
          </div>
        </div>
      ) : null}

      <div
        className={cn(
          "min-h-0 flex-1 bg-background",
          step === "confirm" || step === "running"
            ? "overflow-hidden"
            : "overflow-y-auto"
        )}
      >
        {step === "running" ? (
          <NewSwarmRunningStep
            projectId={projectId}
            runs={launchedRuns}
            fallbackColumns={runningFallbackColumns}
            environments={envList}
            onLeave={leaveRunning}
            onOpenSession={openRunningSession}
          />
        ) : step === "confirm" ? (
          <NewSwarmConfirmStep
            projectId={projectId}
            proposed={proposed}
            onProposedChange={setProposed}
            reusedPersonas={reusedPersonas}
            onRemoveReused={(personaId) =>
              setReusedIds((ids) => ids.filter((id) => id !== personaId))
            }
            preset={preset}
            environmentCount={environmentIds.length}
            environmentLabels={environmentLabels}
            launching={launching}
            errorMessage={errorMessage}
            // Back is the same move as the Describe breadcrumb, so it goes
            // through `goToStep`: it clears the launch error too. Describe
            // renders `errorMessage` as well, and an error the user has
            // already walked away from reads there as a fresh failure of the
            // step they just landed on.
            onBack={() => goToStep(0)}
            onLaunch={(payload) => void handleLaunch(payload)}
            header={flowHeader}
            // Everything Confirm needs to add and edit personas without
            // leaving the page (BB-122).
            availablePersonas={personaList}
            onAddReused={(personaId) =>
              setReusedIds((ids) =>
                ids.includes(personaId) ? ids : [...ids, personaId]
              )
            }
            onSaveReusedPersona={onSaveExistingPersona}
            onSaveReusedGoal={async (journeyRefId, goal) => {
              await onUpdateJourney(journeyRefId, { goal });
            }}
          />
        ) : (
          <div
            className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8"
            data-testid="new-swarm-describe-step"
          >
            {flowHeader}

            <div className="space-y-2">
              <h2 className="text-2xl font-semibold tracking-[-0.02em] text-foreground">
                Create an agentic swarm
              </h2>
              <p className="text-sm font-medium leading-relaxed text-foreground">
                Set up your environment and then describe your users.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="new-swarm-name">
                Swarm name
                <RequiredMark />
              </Label>
              <Input
                id="new-swarm-name"
                value={swarmName}
                maxLength={SWARM_NAME_MAX}
                onChange={(event) => {
                  setSwarmName(event.target.value);
                  setNameEdited(true);
                }}
                placeholder="Name this swarm"
                data-testid="new-swarm-name"
              />
            </div>

            <div className="space-y-2">
              <SwarmTargetComposer
                projectId={projectId}
                environments={envList}
                environmentsLoading={environments === undefined}
                value={targetState}
                onChange={setTargetState}
                draftNameHint={swarmName.trim() || undefined}
                disabled={generating || materializing}
                serverBlock={serverBlock}
                required
              />
              {groundingEnvironmentId ? (
                <ErrorBoundary fallback={null}>
                  <EnvironmentGroundingHint
                    projectId={projectId}
                    environmentId={groundingEnvironmentId}
                  />
                </ErrorBoundary>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="new-swarm-describe">
                Describe your users or bring in existing personas. We build the
                user goals based on your input.
                <RequiredMark />
              </Label>
              <Textarea
                id="new-swarm-describe"
                value={draft}
                rows={3}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={DESCRIBE_PLACEHOLDER}
                data-testid="new-swarm-describe-input"
              />

              {/* Attached personas, as removable rows. They keep their own
                  goals and environments, so they read as what they are —
                  already-authored personas — not as text to edit. */}
              {reusedPersonas.length > 0 ? (
                <ul
                  className="space-y-2"
                  aria-label="Attached personas"
                  data-testid="new-swarm-attached-personas"
                >
                  {reusedPersonas.map((persona) => (
                    <li
                      key={persona._id}
                      className="flex items-center gap-2.5 rounded-lg border border-border bg-muted/25 p-4"
                    >
                      <PersonaPixelAvatar
                        seed={persona._id}
                        shapeIndex={persona.avatarShape}
                        paletteIndex={persona.avatarPalette}
                        size="sm"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">
                          {persona.name}
                        </p>
                        {persona.role ? (
                          <p className="truncate text-xs text-muted-foreground">
                            {persona.role}
                          </p>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        aria-label={"Remove " + persona.name}
                        className="shrink-0 rounded-sm text-muted-foreground transition-colors hover:text-foreground"
                        onClick={() =>
                          setReusedIds((ids) =>
                            ids.filter((id) => id !== persona._id)
                          )
                        }
                      >
                        <X className="size-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}

              {personaList.length > 0 ? (
                // The whole library, as a checklist: this picker is where
                // Describe both attaches and detaches.
                <PersonaPickerPopover
                  personas={personaList}
                  open={personaPickerOpen}
                  onOpenChange={setPersonaPickerOpen}
                  groupLabel="Choose personas"
                  triggerClassName="w-fit"
                  triggerTestId="new-swarm-add-existing-personas"
                  listTestId="new-swarm-existing-personas"
                  mode={{
                    kind: "toggle",
                    selectedIds: reusedIds,
                    onToggle: (personaId) =>
                      setReusedIds((ids) =>
                        ids.includes(personaId)
                          ? ids.filter((id) => id !== personaId)
                          : [...ids, personaId]
                      ),
                  }}
                />
              ) : null}
            </div>

            <div className="space-y-2">
              <Label id="new-swarm-scope-label">
                Select the scope of the swarm
                <RequiredMark />
              </Label>
              <div
                role="radiogroup"
                aria-labelledby="new-swarm-scope-label"
                data-testid="new-swarm-push-intensity"
                className="grid grid-cols-1 gap-1 rounded-xl bg-muted/50 p-1 sm:grid-cols-3"
              >
                {SWARM_INTENSITY_ORDER.map((value) => {
                  const option = SWARM_INTENSITY_PRESETS[value];
                  const selected = pushIntensity === value;
                  const sessions = estimateSwarmSessions(option, targetCount);
                  return (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setPushIntensity(value)}
                      className={cn(
                        "rounded-lg px-3 py-2.5 text-left transition-colors",
                        selected
                          ? "bg-background shadow-sm ring-1 ring-border/60"
                          : "hover:bg-background/60"
                      )}
                    >
                      <span className="block text-sm font-semibold text-foreground">
                        {option.label}
                      </span>
                      {/* Sessions only, per the frame. The count still tracks
                          the live target selection — environments multiply, so
                          a fixed number would understate a multi-client swarm. */}
                      <span className="mt-0.5 block text-sm leading-relaxed text-muted-foreground">
                        {sessions} sessions
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Not in the frame. Currently hidden behind
                `SHOW_INSIGHT_GROUPING` but kept intact, because this is the
                only place the project's clustering default can be set and it
                reaches every swarm's insights — not just this one, which is
                why it sits apart from the controls above rather than among
                them. */}
            {SHOW_INSIGHT_GROUPING && onSetInsightsTuning ? (
              <div
                className="space-y-2"
                data-testid="new-swarm-insight-grouping"
              >
                <Label>Insight grouping</Label>
                <div className="flex flex-wrap items-center gap-2">
                  <ClusterTuningControl
                    value={insightsTuning?.tuning}
                    onApply={handleSaveInsightsTuning}
                    busy={savingInsightsTuning}
                    applyLabel="Save default"
                    // Nothing has run yet, so there are no summaries to
                    // re-analyze from scratch.
                    showForce={false}
                  />
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    How sessions get grouped into themes once runs finish. Saved
                    for this project — it applies to every swarm&rsquo;s
                    insights, including the automatic pass after this one.
                  </p>
                </div>
              </div>
            ) : null}

            {/* `errorMessage` is a bare string from a dozen call sites, most of
                which are not environment failures — `ErrorCard` takes one and
                runs it through `describeError`, so this still gains the
                container, icon and details disclosure that make a long backend
                sentence readable instead of a wall of red text. */}
            {errorMessage ? <ErrorCard error={errorMessage} /> : null}

            <div className="flex flex-wrap items-center justify-end gap-3 pt-4">
              {generating || materializing ? (
                <p
                  className="mr-auto text-sm leading-relaxed text-muted-foreground"
                  data-testid="new-swarm-generate-progress"
                >
                  {generationProgressLine({
                    stage: materializing ? "targets" : "personas",
                    elapsedSeconds: generationElapsedSeconds,
                    personaCount: preset.personaCount,
                    journeyCount: preset.journeyCount,
                  })}
                </p>
              ) : continueHint ? (
                <p
                  id="new-swarm-continue-hint"
                  data-testid="new-swarm-continue-hint"
                  // One slot, two jobs. As a summary it stays muted; as the
                  // only on-screen account of why Continue won't move it
                  // shouldn't read like incidental helper text.
                  className={cn(
                    "mr-auto text-sm leading-relaxed",
                    canContinue ? "text-muted-foreground" : "text-foreground"
                  )}
                >
                  {continueHint}
                </p>
              ) : null}
              <Button type="button" variant="ghost" onClick={leaveFlow}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={!canContinue}
                data-testid="new-swarm-continue"
                // Tie the reason to the control it blocks: a disabled button
                // is skipped by most screen readers, so the sentence beside
                // it is the only account of what's missing.
                aria-describedby={
                  continueHint ? "new-swarm-continue-hint" : undefined
                }
                onClick={handleContinue}
              >
                {generating || materializing ? (
                  <>
                    <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                    {materializing && !generating
                      ? "Preparing targets…"
                      : "Generating…"}
                  </>
                ) : (
                  "Continue"
                )}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
