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
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@mcpjam/design-system/breadcrumb";
import { Label } from "@mcpjam/design-system/label";
import { Loader2 } from "lucide-react";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { McpjamAgentComposer } from "@/components/mcpjam-agent/McpjamAgentComposer";
import { SwarmTargetComposer } from "@/components/swarms/swarm-target-composer";
import {
  materializeSwarmTargets,
  resolveSwarmJourneyPayload,
  SwarmTargetMaterializeError,
  type CreateProjectEnvironmentFn,
} from "@/components/swarms/swarm-target-materialize";
import {
  composerTargetCount,
  emptyComposerState,
  isComposeMode,
  type EnvironmentComposerState,
} from "@/components/environment-composer/environment-stack";
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
  DEFAULT_SWARM_INTENSITY,
  SWARM_INTENSITY_ORDER,
  SWARM_INTENSITY_PRESETS,
  estimateSwarmSessions,
  type SwarmPushIntensity,
} from "@/components/swarms/swarm-intensity";
import {
  SWARM_QUERIES,
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
import type { GoalJudgeConfig } from "@/components/shared/session-quality/judge-config";
import { track } from "@/lib/analytics";
import { toast } from "@/lib/toast";
import { ClusterTuningControl } from "@/components/shared/usage-insights/ClusterTuningControl";
import type { ClusterTuning } from "@/lib/cluster-tuning";
import { environmentLabel } from "@/lib/environment-label";
import { ErrorCard } from "@/components/ui/error-card";
import { cn } from "@/lib/utils";

const CREATE_STEPS = [
  "Describe",
  "Confirm personas",
  "Running",
  "Findings",
] as const;

// Prefixed with "e.g." on purpose: the un-prefixed sentence read as filled-in
// content, so users hit a disabled button with no idea the box was empty.
const DESCRIBE_PLACEHOLDER =
  "e.g. Finance ops reconciling payouts, and devs wiring up subscription billing.";

/** Concurrent launches. Bounded so a 60-journey launch doesn't open 60
 * simultaneous requests, while still finishing in seconds. */
const LAUNCH_CONCURRENCY = 4;

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

/** Run `worker` over `items`, at most `limit` at a time. */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await worker(items[index]);
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
  onEditExistingPersona,
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
    }
  ) => Promise<void>;
  launchJourney: (
    journeyId: string,
    opts?: { swarmRunGroupId?: string }
  ) => Promise<
    { status: "launched"; runId?: string } | { status: "already_launching" }
  >;
  onCancel: () => void;
  /** Hands back a label per launched run so the sessions view can name the
   * groups after the persona and journey instead of a run id. */
  onDone: (runLabels: Map<string, string>) => void;
  /** Leave create flow and open Personas for an existing persona. */
  onEditExistingPersona: (personaRefId: string) => void;
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
  const [step, setStep] = useState<"describe" | "confirm" | "running">(
    "describe"
  );
  const [draft, setDraft] = useState("");
  const [targetState, setTargetState] = useState<EnvironmentComposerState>(
    emptyComposerState
  );
  /** Env ids after materialize (compose path). Cleared when the composer changes. */
  const [resolvedEnvironmentIds, setResolvedEnvironmentIds] = useState<
    string[] | null
  >(null);
  const [resolvedEnvironments, setResolvedEnvironments] = useState<
    ProjectEnvironmentView[] | null
  >(null);
  /** Newly created envs may lag the live list query — keep them for payload/labels. */
  const [createdEnvOverlay, setCreatedEnvOverlay] = useState<
    ProjectEnvironmentView[]
  >([]);
  const [materializing, setMaterializing] = useState(false);
  const [savingInsightsTuning, setSavingInsightsTuning] = useState(false);

  // The project's standing clustering settings. Only subscribed when the row
  // is actually rendered — an older backend without the query would otherwise
  // make every create flow subscribe to a function that does not exist.
  const insightsTuning = useQuery(
    SWARM_QUERIES.getSwarmInsightsTuning as any,
    onSetInsightsTuning ? ({ projectId } as any) : "skip"
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
    DEFAULT_SWARM_INTENSITY
  );
  const [reusedIds, setReusedIds] = useState<string[]>([]);
  const [proposed, setProposed] = useState<ProposedPersona[]>([]);
  const [launchedRuns, setLaunchedRuns] = useState<SwarmLaunchedRun[]>([]);
  const [generating, setGenerating] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Sync latch: `generating`/`launching` are state, so two fast clicks in one
  // tick would both see the old value and fire twice.
  const inFlightRef = useRef(false);
  // Labels for Overview session grouping — set at launch, handed to onDone
  // when the user leaves Running (Cancel / Stop / Look now).
  const launchedRunLabelsRef = useRef<Map<string, string>>(new Map());
  // Rows a previous attempt already created. A launch failure leaves the user
  // on Confirm with a Retry, and without this the retry would create every
  // persona and journey a SECOND time — the rows are already real, only the
  // launch needs redoing.
  const persistedTargetsRef = useRef<LaunchTarget[] | null>(null);
  // Environments baked into those persisted journeys. If the user goes Back
  // and changes the env selection, retrying must NOT relaunch the old
  // single-client journeys while the matrix shows the new multi-client set.
  const persistedEnvironmentKeyRef = useRef<string | null>(null);
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
  const persistedRunGroupIdRef = useRef<string | null>(null);
  /**
   * Stable prefix for this authoring session's idempotency keys.
   *
   * Every row the launch creates derives its key from this plus its own stable
   * local key, so a retry re-sends the SAME keys and the backend replays the
   * rows it already wrote instead of creating a second persona and journey per
   * proposal. Known gap: the ref is in memory, so a reload between attempts
   * loses it — the same exposure `persistedTargetsRef` already has.
   */
  const flowIdRef = useRef<string | null>(null);
  /** The swarm row this launch created, so a retry doesn't create a second. */
  const persistedSwarmIdRef = useRef<string | null>(null);

  const envList = useMemo(() => environments ?? [], [environments]);
  const composeMode = isComposeMode(targetState);
  const targetCount = composerTargetCount(targetState);
  const environmentIds = useMemo(() => {
    if (resolvedEnvironmentIds) return resolvedEnvironmentIds;
    if (!composeMode) return targetState.environmentIds;
    return [];
  }, [
    composeMode,
    resolvedEnvironmentIds,
    targetState.environmentIds,
  ]);
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

  const environmentSelectionKey = useMemo(
    () =>
      [
        composeMode ? "compose" : "castles",
        ...[...targetState.environmentIds].sort(),
        ...[...targetState.stack.hostIds].sort(),
        targetState.stack.serverAttachmentId ?? "",
        targetState.stack.computerEnvironmentId ?? "",
        targetState.customized ? "custom" : "seeded",
      ].join("|"),
    [composeMode, targetState]
  );

  useEffect(() => {
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

  // Generating and reusing are two independent doors into Confirm, and they
  // compose. Writing anything in the box asks for a generation (which needs
  // targets to ground on); selecting personas alone is a complete swarm on
  // its own — those journeys carry their own environments, so requiring one
  // here would block a returning user over a field their run never reads.
  const wantsGenerate = draft.trim().length > 0;
  const canGenerate =
    wantsGenerate && hasGenerateTargets && !generating && !materializing;
  const canContinue =
    generating || materializing
      ? false
      : wantsGenerate
        ? canGenerate
        : reusedIds.length > 0;

  /** Why the primary button is disabled, or a short summary when it isn't. */
  const continueHint = (() => {
    if (generating || materializing) return null;
    if (!canContinue) {
      if (wantsGenerate) {
        return environmentsEnabled
          ? "Pick an environment or clients to generate against."
          : "Pick clients to generate against.";
      }
      if (personaList.length > 0) {
        return "Describe your users, or pick a persona you already have.";
      }
      return "Describe your users to continue.";
    }
    const reused = reusedIds.length;
    const fresh = preset.personaCount;
    if (wantsGenerate && reused > 0) {
      return `${reused} existing · ${fresh} new on next step`;
    }
    if (wantsGenerate) {
      return `${fresh} new ${fresh === 1 ? "persona" : "personas"} on next step`;
    }
    return `${reused} ${reused === 1 ? "persona" : "personas"} selected`;
  })();

  const materializeArgs = useCallback(
    () => ({
      projectId,
      stackName: draft.trim() || "Swarm setup",
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
      targetState.stack,
    ]
  );

  const resolveTargets = useCallback(async () => {
    const liveWithOverlay = (() => {
      const byId = new Map(envList.map((e) => [e.environmentId, e]));
      for (const env of createdEnvOverlay) {
        byId.set(env.environmentId, env);
      }
      return [...byId.values()];
    })();
    const resolved = await resolveSwarmJourneyPayload({
      compose: composeMode,
      castleIds: targetState.environmentIds,
      legos: targetState.stack,
      liveEnvironments: liveWithOverlay,
      materialize: {
        ...materializeArgs(),
        liveEnvironments: liveWithOverlay,
      },
    });
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
    targetState,
  ]);

  const handleSaveAsEnvironments = useCallback(async () => {
    if (!composeMode || targetState.stack.hostIds.length === 0) return;
    setMaterializing(true);
    setErrorMessage(null);
    try {
      const result = await materializeSwarmTargets(materializeArgs());
      if (result.createdIds.length > 0) {
        const created = result.environments.filter((env) =>
          result.createdIds.includes(env.environmentId)
        );
        setCreatedEnvOverlay((prev) => {
          const byId = new Map(prev.map((e) => [e.environmentId, e]));
          for (const env of created) byId.set(env.environmentId, env);
          return [...byId.values()];
        });
      }
      // Commit to a pure saved-environment selection so launch skips re-create.
      // Overlay covers names until the live list query catches up.
      setTargetState({
        environmentIds: result.environmentIds,
        stack: targetState.stack,
        customized: false,
      });
      setResolvedEnvironmentIds(result.environmentIds);
      setResolvedEnvironments(result.environments);
      toast.success(
        result.createdIds.length > 0
          ? `Saved ${result.createdIds.length} environment${
              result.createdIds.length === 1 ? "" : "s"
            }`
          : "Matched existing environments"
      );
    } catch (err) {
      setErrorMessage(
        err instanceof SwarmTargetMaterializeError
          ? err.message
          : errorMessageOf(err, "Could not save environments.")
      );
    } finally {
      setMaterializing(false);
    }
  }, [composeMode, materializeArgs, targetState.stack]);

  const handleGenerate = useCallback(async () => {
    if (!canGenerate || inFlightRef.current) return;
    inFlightRef.current = true;
    setGenerating(true);
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
        err instanceof SwarmTargetMaterializeError
          ? err.message
          : err instanceof SwarmGenerateError
            ? err.message
            : errorMessageOf(err, "Failed to generate personas.")
      );
    } finally {
      inFlightRef.current = false;
      setGenerating(false);
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
            err instanceof SwarmTargetMaterializeError
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
              // The Describe paragraph is the closest thing to a title the user
              // gave us; trimmed to the backend's cap. Renameable afterwards.
              name: draft.trim().slice(0, 120) || "Swarm",
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
              firstError ??= errorMessageOf(
                err,
                "A run could not be launched."
              );
            }
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
      toast[launched === targets.length ? "success" : "warning"](
        launched === targets.length
          ? `Launched ${launched} ${launched === 1 ? "run" : "runs"}`
          : `Launched ${launched} of ${targets.length} runs`
      );
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

  const leaveRunning = useCallback(() => {
    onDone(launchedRunLabelsRef.current);
  }, [onDone]);

  const activeStepIndex =
    step === "describe" ? 0 : step === "confirm" ? 1 : 2;

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
      <div className="shrink-0 border-b border-border/60 bg-muted/15 px-4 py-2.5 sm:px-6">
        <div className="flex min-w-0 items-center gap-4">
          <Breadcrumb className="min-w-0 flex-1">
            <BreadcrumbList className="min-w-0 flex-nowrap">
              {CREATE_STEPS.map((label, index) => {
                const isActive = index === activeStepIndex;
                const canGoBack =
                  index < activeStepIndex &&
                  !launching &&
                  !generating &&
                  !materializing;
                return (
                  <Fragment key={label}>
                    {index > 0 ? <BreadcrumbSeparator /> : null}
                    <BreadcrumbItem>
                      {isActive ? (
                        <BreadcrumbPage className="font-medium">
                          {label}
                        </BreadcrumbPage>
                      ) : canGoBack ? (
                        <BreadcrumbLink asChild>
                          <button
                            type="button"
                            className="inline-flex border-0 bg-transparent p-0 font-medium text-muted-foreground hover:text-foreground"
                            onClick={() => goToStep(index)}
                          >
                            {label}
                          </button>
                        </BreadcrumbLink>
                      ) : (
                        <span className="text-muted-foreground/70">{label}</span>
                      )}
                    </BreadcrumbItem>
                  </Fragment>
                );
              })}
            </BreadcrumbList>
          </Breadcrumb>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0"
            disabled={launching}
            onClick={step === "running" ? leaveRunning : onCancel}
          >
            {step === "running" ? "Leave" : "Cancel"}
          </Button>
        </div>
      </div>

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
            onBack={() => setStep("describe")}
            onLaunch={(payload) => void handleLaunch(payload)}
            onEditExistingPersona={onEditExistingPersona}
          />
        ) : (
          <div className="mx-auto flex max-w-5xl flex-col gap-8 px-6 py-8 sm:px-8">
            <div className="space-y-2">
              <h2 className="text-2xl font-semibold tracking-[-0.02em] text-foreground">
                Who uses this server, and what do they try to do?
              </h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Bring in personas you already have, describe new ones, or both.
                We infer the goals, the clients and a scoring rubric — you
                confirm all of it next.
              </p>
            </div>

            {/* Sources: choose existing and/or describe new. Shared setup
                (environments + intensity) sits below so it isn't nested under
                only one door. */}
            <div
              className={cn(
                "grid gap-6",
                personaList.length > 0
                  ? "md:grid-cols-2 md:gap-8"
                  : ""
              )}
            >
              {personaList.length > 0 ? (
                <section className="flex min-h-0 min-w-0 flex-col gap-3">
                  <div className="shrink-0 space-y-1">
                    <Label>Choose personas</Label>
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      Optional. They keep their own goals and environments.
                    </p>
                  </div>
                  <div
                    className="flex h-72 min-w-0 flex-col gap-1 overflow-y-auto rounded-xl border border-border/50 bg-muted/20 p-2"
                    role="group"
                    aria-label="Choose personas"
                    data-testid="new-swarm-existing-personas"
                  >
                    {personaList.map((persona) => {
                      const selected = reusedIds.includes(persona._id);
                      return (
                        <button
                          key={persona._id}
                          type="button"
                          role="checkbox"
                          aria-checked={selected}
                          aria-label={`Include ${persona.name}`}
                          onClick={() =>
                            setReusedIds((ids) =>
                              selected
                                ? ids.filter((id) => id !== persona._id)
                                : [...ids, persona._id]
                            )
                          }
                          className={cn(
                            "flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left text-sm transition-colors",
                            selected
                              ? "border-border bg-background text-foreground shadow-sm"
                              : "border-transparent text-muted-foreground hover:bg-background/70"
                          )}
                        >
                          <PersonaPixelAvatar
                            seed={persona._id}
                            shapeIndex={persona.avatarShape}
                            paletteIndex={persona.avatarPalette}
                            size="sm"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium text-foreground">
                              {persona.name}
                            </span>
                            {persona.role ? (
                              <span className="block truncate text-xs text-muted-foreground">
                                {persona.role}
                              </span>
                            ) : null}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              ) : null}

              <section className="flex min-h-0 min-w-0 flex-col gap-3">
                <div className="shrink-0 space-y-1">
                  <Label>
                    {personaList.length > 0
                      ? "Or describe new ones"
                      : "Describe your users"}
                  </Label>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {personaList.length > 0
                      ? "Optional. We’ll propose personas and goals for you to confirm."
                      : "We’ll propose personas and goals for you to confirm."}
                  </p>
                </div>
                <McpjamAgentComposer
                  value={draft}
                  onChange={setDraft}
                  onSubmit={handleContinue}
                  placeholder={DESCRIBE_PLACEHOLDER}
                  minRows={personaList.length > 0 ? 8 : 3}
                  maxRows={personaList.length > 0 ? 16 : 8}
                  className={
                    personaList.length > 0
                      ? "flex h-72 min-h-0 flex-col [&_textarea]:min-h-0 [&_textarea]:flex-1"
                      : undefined
                  }
                />
              </section>
            </div>

            <section
              className="space-y-5 rounded-xl border border-border/50 bg-muted/15 p-4 sm:p-5"
              data-testid="new-swarm-shared-setup"
            >
              <div className="space-y-1">
                <p className="text-sm font-semibold text-foreground">
                  Shared setup
                </p>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Targets ground new personas. Intensity sizes how many we
                  generate — reused personas keep their own goals.
                </p>
              </div>

              <div className="space-y-2">
                <SwarmTargetComposer
                  projectId={projectId}
                  environments={envList}
                  environmentsLoading={environments === undefined}
                  value={targetState}
                  onChange={setTargetState}
                  draftNameHint={draft.trim() || undefined}
                  onSaveAsEnvironments={handleSaveAsEnvironments}
                  savingEnvironments={materializing}
                  disabled={generating || materializing}
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

              {/* Deliberately its own row rather than a chip in the lego strip
                  above: every chip up there pins what THIS swarm executes,
                  while this is a project setting whose effects reach every
                  swarm's insights. The hint says so out loud — the placement
                  alone would imply a narrower blast radius than it has. */}
              {onSetInsightsTuning ? (
                <div className="space-y-2" data-testid="new-swarm-insight-grouping">
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
                      How sessions get grouped into themes once runs finish.
                      Saved for this project — it applies to every swarm&rsquo;s
                      insights, including the automatic pass after this one.
                    </p>
                  </div>
                </div>
              ) : null}

              <div className="space-y-2">
                <Label>How hard to push</Label>
                <div
                  role="radiogroup"
                  aria-label="How hard to push"
                  data-testid="new-swarm-push-intensity"
                  className="grid grid-cols-1 gap-1 rounded-xl bg-muted/50 p-1 sm:grid-cols-3"
                >
                  {SWARM_INTENSITY_ORDER.map((value) => {
                    const option = SWARM_INTENSITY_PRESETS[value];
                    const selected = pushIntensity === value;
                    const sessions = estimateSwarmSessions(
                      option,
                      targetCount
                    );
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
                        <span className="mt-0.5 block text-sm leading-relaxed text-muted-foreground">
                          {option.personaCount} personas · {sessions} sessions ·{" "}
                          {option.eta}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </section>

            {/* `errorMessage` is a bare string from a dozen call sites, most of
                which are not environment failures — `ErrorCard` takes one and
                runs it through `describeError`, so this still gains the
                container, icon and details disclosure that make a long backend
                sentence readable instead of a wall of red text. */}
            {errorMessage ? <ErrorCard error={errorMessage} /> : null}

            <div className="flex flex-wrap items-center gap-3 border-t border-border/40 pt-4">
              <Button
                type="button"
                disabled={!canContinue}
                data-testid="new-swarm-continue"
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
              {continueHint ? (
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {continueHint}
                </p>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
