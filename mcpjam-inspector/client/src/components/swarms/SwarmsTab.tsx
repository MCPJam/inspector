/**
 * Project-scoped Swarms surface (redesign): Persona → Journey → Run.
 *
 * Replaces the old host-anchored `ChatboxesTab product="swarm"`. Personas and
 * journeys live at the project level; a journey targets one-or-more hosts and,
 * when run, fans out one single-host session per (host × sessionsPerHost).
 *
 * Top-level views (ViewModeSelector). Overview is the landing tab; a deep link
 * naming a session or a run overrides it, because those name a place:
 *   - Overview — outcome metrics, recent runs grouped by journey, and the
 *     failing rubric criteria on each journey's latest run
 *   - Personas — persona sidebar, journey cards, run matrix / live stream
 *   - Sessions — flat chatSessions browser with top-bar persona filter
 *     (`listSessionsByPersona` + shared ShareUsageThreadList/Detail)
 *   - Insights — session-flow sankey over the project's swarm sessions
 *
 * Consumes the project-scoped backend: personas:*, journeys:*, journeyRuns:*.
 *
 * ## Agent bridge (v1 scope)
 *
 * This is the surface component that calls `useSurfaceAgentBridge` for the
 * `swarms` tool group (create persona, open journey form, launch run). Two
 * scoping decisions, both grounded in the actual UI:
 *
 * - **Promote-to-eval is OUT of v1.** The promotable session is lazily
 *   paginated inside `RunSessionsView` (per expanded run) and there is no
 *   top-level "selected session"; an agent tool couldn't resolve one without a
 *   large lift of run/session state that would diverge the snapshot from the
 *   multi-card view. The human uses the in-view "Promote to test case" button.
 * - **Host CRUD is OUT of v1.** Journeys attach existing project hosts; create
 *   / edit / delete hosts live on Connect. The snapshot still surfaces host
 *   TARGETS (names) via the journey→hosts mapping.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import {
  ChevronDown,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { EditableTitle } from "@/components/evals/EditableTitle";
import { TextareaAutosize } from "@/components/ui/textarea-autosize";
import { PersonaPixelAvatar } from "@/components/swarms/persona-pixel-avatar";
import { PersonaAvatarLookPicker } from "@/components/swarms/persona-avatar-look-picker";
import { JourneyNetworkBackdrop } from "@/components/swarms/journey-network-backdrop";
import { SwarmsEmptyHero } from "@/components/swarms/swarms-empty-hero";
import {
  launchJourneyRun,
  LaunchJourneyRunError,
  SWARM_QUERIES,
  DEFAULT_PAGE_SIZE,
  type JourneyRun,
  type GoalScoreRollup,
  type JourneySessionRow,
  type PersonaTrackRecord,
} from "@/lib/swarm-api";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";
import {
  buildEnvJourneyPayload,
  MAX_ENVIRONMENTS_PER_JOURNEY,
} from "@/components/swarms/journey-environments";
import { EnvironmentPicker } from "@/components/project-environments/environment-picker";
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";
import { shouldQueryProjectId } from "@/hooks/useProjects";
// The badge + wide-shape guard live in the shared session-quality module so
// surfaces rendered inside this subtree can use them without an import cycle.
// Re-exported here because the goal-score unit test imports from `../SwarmsTab`.
export {
  SessionGoalScoreBadge,
  toSessionGoalScore,
} from "@/components/shared/session-quality/session-goal-score-badge";
import { ShareUsageThreadDetail } from "@/components/connection/share-usage/ShareUsageThreadDetail";
import { JudgesSection } from "@/components/evals/judges-section";
import { JourneyRubricEditor } from "@/components/swarms/journey-rubric-editor";
import { areAllChecksValid } from "@/components/evals/checks-section";
import { RunScorecardSection } from "@/components/swarms/run-scorecard";
import {
  serializeRubricForWire,
  type JourneyCriterion,
} from "@/shared/journey-rubric";
import { useAvailableModels } from "@/hooks/use-available-models";
import type { GoalJudgeConfig } from "@/components/shared/session-quality/judge-config";
import {
  buildEvalsPath,
  buildSwarmSessionPath,
  navigateApp,
  parseSwarmSessionParams,
} from "@/lib/app-navigation";
import { getShareableAppOrigin } from "@/lib/chatbox-session";
import { ConvertSwarmSessionDialog } from "@/components/swarms/convert-swarm-session-dialog";
import { SwarmsSessionsPanel } from "@/components/swarms/SwarmsSessionsPanel";
import { SwarmInsightsPanel } from "@/components/swarms/SwarmInsightsPanel";
import { SwarmOverviewPanel } from "@/components/swarms/swarm-overview-panel";
import { SwarmLiveStreamPane } from "@/components/swarms/journey-run-results";
import {
  RunSessionsProvider,
  useRunSessionsContext,
} from "@/components/swarms/run-sessions-context";
import {
  JourneyList,
  type JourneyListJourney,
  type JourneyRunSelection,
} from "@/components/swarms/journey-list";
import { GenerateSwarmDialog } from "@/components/swarms/GenerateSwarmDialog";
import {
  formatJourneyRelativeTime,
  runStatusChipClass,
  runSummaryLine,
} from "@/components/swarms/journey-run-format";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
// Re-exported for the goal-score unit test, which imports from `../SwarmsTab`.
export { goalScoreAvgLabel } from "@/components/swarms/journey-run-format";
import { ViewModeSelector } from "@/components/shared/view-mode-selector";
import { useSurfaceAgentBridge } from "@/lib/webmcp/use-surface-agent-bridge";
import { createInspectorCommandClientError } from "@/lib/inspector-command-handlers";
import type {
  CreatePersonaInspectorCommand,
  LaunchSwarmRunInspectorCommand,
  OpenJourneyFormInspectorCommand,
} from "@/shared/inspector-command.js";

// Cap the agent snapshot's list sizes — a redacted STATE overview, never a
// data dump. Personas/journeys are usually few; the cap just bounds the
// pathological case.
const AGENT_SNAPSHOT_MAX_PERSONAS = 30;
const AGENT_SNAPSHOT_MAX_JOURNEYS = 30;

type Persona = {
  _id: string;
  personaId: string;
  name: string;
  role: string;
  notes: string;
  /** Optional 8-bit look (Inspector PersonaPixelAvatar). */
  avatarShape?: number;
  avatarPalette?: number;
};
type Journey = {
  _id: string;
  personaRefId: string;
  name?: string;
  goal: string;
  hostIds: string[];
  /** Standalone server group shared across all hosts at launch (suite-like). */
  serverAttachmentId?: string | null;
  /** Env-based fan-out (Project Environments). Non-empty ⇒ env-based. */
  environmentIds?: string[] | null;
  config: { sessionsPerHost: number; maxTurns: number };
  /** Per-journey goal-completion judge config (shared envelope with suites). */
  judgeConfig?: GoalJudgeConfig;
};
type HostItem = {
  hostId: string;
  name: string;
  // Enriched by `hosts:listHosts` (additive) — powers the journey host chips.
  modelId?: string;
  serverCount?: number;
  hasComputer?: boolean;
  ownerScope?: { type: string } | null;
};

interface SwarmsTabProps {
  projectId: string | null;
  isAuthenticated: boolean;
}

// ── hooks ─────────────────────────────────────────────────────────────────
function usePersonas(projectId: string | null) {
  return useQuery(
    SWARM_QUERIES.listPersonas as any,
    projectId ? ({ projectId } as any) : "skip"
  ) as Persona[] | undefined;
}
function useJourneys(personaRefId: string | null) {
  return useQuery(
    SWARM_QUERIES.listJourneysByPersona as any,
    personaRefId ? ({ personaRefId } as any) : "skip"
  ) as Journey[] | undefined;
}
function useProjectHosts(projectId: string | null) {
  return useQuery(
    SWARM_QUERIES.listHosts as any,
    projectId ? ({ projectId } as any) : "skip"
  ) as HostItem[] | undefined;
}
/** Live project environments for swarm create/generate (environments-only). */
function useProjectEnvironmentsList(projectId: string | null) {
  return useQuery(
    SWARM_QUERIES.listEnvironments as any,
    // `shouldQueryProjectId` (not a bare truthiness check): a local/placeholder
    // or UUID project id during a project transition would 500 the Convex arg
    // validator, so skip until the id is a real queryable project.
    shouldQueryProjectId(projectId) ? ({ projectId } as any) : "skip"
  ) as ProjectEnvironmentView[] | undefined;
}
function usePersonaTrackRecord(personaRefId: string | null) {
  return useQuery(
    SWARM_QUERIES.personaTrackRecord as any,
    personaRefId ? ({ personaRefId } as any) : "skip"
  ) as PersonaTrackRecord | undefined;
}

/**
 * Owns the `listRunningPersonaRefIds` subscription in isolation so a missing
 * backend deploy (unknown query) cannot white-screen Swarms — the parent
 * wraps this in `ErrorBoundary` and keeps an empty running set on failure.
 */
function RunningPersonasSubscriber({
  projectId,
  onChange,
}: {
  projectId: string | null;
  onChange: (ids: string[]) => void;
}) {
  const ids = useQuery(
    SWARM_QUERIES.listRunningPersonaRefIds as any,
    projectId ? ({ projectId } as any) : "skip"
  ) as string[] | undefined;

  useEffect(() => {
    onChange(ids ?? []);
  }, [ids, onChange]);

  return null;
}

export function SwarmsTab({ projectId, isAuthenticated }: SwarmsTabProps) {
  // Don't subscribe to project-scoped Convex reads until auth is ready — a
  // signed-out/loading mount with a persisted project would otherwise surface
  // authorization errors instead of holding the screen.
  const effectiveProjectId = isAuthenticated ? projectId : null;
  const personas = usePersonas(effectiveProjectId);
  const hosts = useProjectHosts(effectiveProjectId);
  const environmentsEnabled = useProjectEnvironmentsEnabled();
  const environments = useProjectEnvironmentsList(effectiveProjectId);
  const [runningPersonaIds, setRunningPersonaIds] = useState<string[]>([]);
  const runningSet = useMemo(
    () => new Set(runningPersonaIds),
    [runningPersonaIds]
  );
  const onRunningPersonasChange = useCallback((ids: string[]) => {
    setRunningPersonaIds(ids);
  }, []);
  // Restore a copied session deep-link (`/swarms?persona=&run=&host=&session=`).
  // Parse ONCE on mount so later user navigation isn't clobbered by the URL.
  const deepLink = useMemo(
    () => parseSwarmSessionParams(window.location.search),
    []
  );
  type SwarmViewMode = "overview" | "journeys" | "sessions" | "insights";
  const SWARM_VIEW_OPTIONS = [
    { value: "overview" as const, label: "Overview" },
    { value: "journeys" as const, label: "Personas" },
    { value: "sessions" as const, label: "Sessions" },
    { value: "insights" as const, label: "Insights" },
  ];
  // Session deep-links open the flat Sessions browser; a run-only link needs
  // the Journeys matrix / live stream, so it lands there. Everything else
  // starts on the Overview.
  const [viewMode, setViewMode] = useState<SwarmViewMode>(() => {
    if (deepLink.threadId) return "sessions";
    if (deepLink.runId || deepLink.personaRefId) return "journeys";
    return "overview";
  });
  const [selectedPersonaId, setSelectedPersonaId] = useState<string | null>(
    () => deepLink.personaRefId ?? null
  );
  // Sessions-tab persona filter — independent of the Personas-tab selection:
  // that tab auto-selects a persona to land on, which must not narrow the flat
  // Sessions browser away from its all-project default. Session deep-links
  // still restore their persona filter.
  const [sessionsPersonaFilter, setSessionsPersonaFilter] = useState<
    string | null
  >(() => (deepLink.threadId ? deepLink.personaRefId ?? null : null));
  // Session opened from a drill-down (Insights, or an Overview finding).
  // Carried into the Sessions browser as its initial selection when the view
  // flips; wins over the URL deep-link because it is the more recent intent.
  const [drilldownThreadId, setDrilldownThreadId] = useState<string | null>(
    null
  );
  const handleOpenSessionDrilldown = useCallback((sessionId: string) => {
    setDrilldownThreadId(sessionId);
    setViewMode("sessions");
  }, []);
  const journeys = useJourneys(selectedPersonaId);
  // Lifted for the agent snapshot (one subscription).

  const createPersona = useMutation("personas:createPersona" as any);
  const updatePersona = useMutation("personas:updatePersona" as any);
  const deletePersona = useMutation("personas:deletePersona" as any);
  const createJourney = useMutation("journeys:createJourney" as any);

  // AI generation ("Generate persona" / "Generate journeys"). Both write real
  // rows through the mutations above; running them stays a separate click.
  const [generateMode, setGenerateMode] = useState<
    "persona" | "journeys" | null
  >(null);

  const savePersonaField = useCallback(
    async (
      personaRefId: string,
      patch: {
        name?: string;
        role?: string;
        notes?: string;
        avatarShape?: number;
        avatarPalette?: number;
      }
    ) => {
      try {
        await updatePersona({ personaRefId, ...patch } as any);
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to update persona"
        );
        throw error;
      }
    },
    [updatePersona]
  );

  const handleDeletePersona = useCallback(
    async (persona: Persona) => {
      if (
        !window.confirm(
          `Delete persona "${persona.name}"? Its journeys are hidden but historical runs are kept.`
        )
      ) {
        return;
      }
      try {
        await deletePersona({ personaRefId: persona._id } as any);
        setSelectedPersonaId(null);
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to delete persona"
        );
      }
    },
    [deletePersona]
  );

  const selectedPersona = useMemo(
    () => personas?.find((p) => p._id === selectedPersonaId) ?? null,
    [personas, selectedPersonaId]
  );

  // Always land on someone — pick the first list entry when none is selected or
  // the current id no longer exists (deleted / stale deep link).
  //
  // Deliberately NOT gated on `viewMode`. It used to be, back when Personas was
  // the landing tab and the gate was a no-op; with Overview landing instead, a
  // gate would leave `selectedPersonaId` null on a fresh visit — and the agent
  // bridge's `ui_launch_swarm_run` resolves journeys through `selectedPersona`,
  // so it would answer "Select a persona first" for journeys the user can see
  // listed in front of them. The Sessions tab is unaffected either way: its
  // persona filter is separate state (`sessionsPersonaFilter`) precisely so
  // this auto-select cannot narrow the flat browser.
  useEffect(() => {
    if (personas === undefined || personas.length === 0) return;
    const currentValid =
      selectedPersonaId !== null &&
      personas.some((p) => p._id === selectedPersonaId);
    if (!currentValid) {
      setSelectedPersonaId(personas[0]._id);
    }
  }, [personas, selectedPersonaId]);
  // Gate on the VALIDATED persona, not the raw URL-derived id: a copied
  // /swarms?persona=... deep link opened while signed out (or with a stale id)
  // must not subscribe getPersonaTrackRecord before the allowed persona list
  // has loaded and matched — that surfaces backend authorization errors.
  const trackRecord = usePersonaTrackRecord(
    selectedPersona ? selectedPersonaId : null
  );

  // New-journey form, lifted so `ui_open_journey_form` can open it (the
  // prefill-over-commit posture — a journey targets hosts + sets fan-out
  // config, so the human finishes and submits it).
  const [journeyFormOpen, setJourneyFormOpen] = useState(false);
  const [journeyGoalSeed, setJourneyGoalSeed] = useState("");
  const [creatingPersona, setCreatingPersona] = useState(false);
  const [personaAutoEditId, setPersonaAutoEditId] = useState<string | null>(
    null
  );

  const handleCreatePersona = useCallback(async () => {
    if (!projectId || creatingPersona) return;
    setCreatingPersona(true);
    try {
      const row = await createPersona({
        projectId,
        name: "New persona",
        role: "Role",
      } as any);
      setPersonaAutoEditId(row._id);
      setSelectedPersonaId(row._id);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to create persona"
      );
    } finally {
      setCreatingPersona(false);
    }
  }, [projectId, creatingPersona, createPersona]);

  // Run detail opened in the right-hand panel. `runSnapshot` seeds the panel
  // until its own `listJourneyRuns` subscription resolves the run (identical
  // query args as the journey block, so Convex dedupes the subscription).
  const [runDetail, setRunDetail] = useState<
    (JourneyRunSelection & { runSnapshot: JourneyRun }) | null
  >(null);
  const openRunDetail = useCallback(
    (
      journey: JourneyListJourney,
      run: JourneyRun,
      targetKey: string | null
    ) => {
      setRunDetail({
        journeyId: journey._id,
        runId: run._id,
        targetKey,
        runSnapshot: run,
      });
    },
    []
  );
  const closeRunDetail = useCallback(() => setRunDetail(null), []);
  // Close the panel when the persona changes or its journey disappears.
  useEffect(() => {
    setRunDetail(null);
  }, [selectedPersonaId]);
  useEffect(() => {
    if (
      runDetail &&
      journeys !== undefined &&
      !journeys.some((j) => j._id === runDetail.journeyId)
    ) {
      setRunDetail(null);
    }
  }, [journeys, runDetail]);
  const detailJourney = runDetail
    ? journeys?.find((j) => j._id === runDetail.journeyId) ?? null
    : null;

  // ── Agent bridge ──────────────────────────────────────────────────────────
  // The swarms tool group + this screen's command handlers and snapshot. Lives
  // HERE in the surface component (SwarmsTab owns personas/journeys and the
  // launch path and shares no state hook with another surface). Handlers reuse
  // the EXACT callbacks the buttons use: the createPersona mutation, the
  // new-journey form, and the launchJourneyRun REST path (with the same
  // per-launch idempotency key).
  const agentOperable = isAuthenticated && Boolean(projectId);
  const requireAgentOperable = () => {
    if (!agentOperable) {
      throw createInspectorCommandClientError(
        "unsupported_in_mode",
        "Swarms is locked here — sign in and select a project before using the swarm tools."
      );
    }
  };

  // One idempotency key per (journey) launch, retained verbatim after ANY
  // unsuccessful response and reused on retry so a network retry can't spawn a
  // duplicate run (the backend dedupes the reused key). Cleared only after a
  // confirmed 2xx — mirrors the Run button's `launchKeyRef` semantics.
  const launchKeysRef = useRef<Map<string, string>>(new Map());
  const launchingRef = useRef<Set<string>>(new Set());

  // SINGLE per-journey launch coordinator, shared by BOTH the Run button
  // (JourneyCard) and the agent's ui_launch_swarm_run. Sharing launchKeysRef +
  // launchingRef is what lets the backend dedupe a concurrent button-click and
  // agent-launch of the same journey into ONE paid run — two independent key
  // stores would each mint a key and spawn two runs. Throws LaunchJourneyRunError
  // (incl. 402) so each caller can shape its own error; the key is retained on
  // ANY failure and dropped only after a confirmed 2xx.
  const launchJourney = useCallback(
    async (
      journeyId: string
    ): Promise<
      { status: "launched"; runId?: string } | { status: "already_launching" }
    > => {
      if (!projectId) {
        throw new LaunchJourneyRunError(0, "No project is selected.");
      }
      if (launchingRef.current.has(journeyId)) {
        return { status: "already_launching" };
      }
      let launchKey = launchKeysRef.current.get(journeyId);
      if (!launchKey) {
        launchKey = crypto.randomUUID();
        launchKeysRef.current.set(journeyId, launchKey);
      }
      launchingRef.current.add(journeyId);
      try {
        const result = await launchJourneyRun({
          journeyId,
          projectId,
          launchKey,
        });
        launchKeysRef.current.delete(journeyId); // confirmed 2xx
        return { status: "launched", runId: result.runId };
      } finally {
        // Retain the key on failure (handled by the thrown error reaching the
        // caller); only clear the in-flight marker.
        launchingRef.current.delete(journeyId);
      }
    },
    [projectId]
  );

  // Exact (case-insensitive) resolution against the loaded lists — unknown or
  // ambiguous → invalid_request, never a fuzzy guess.
  const resolvePersona = (raw: unknown): Persona => {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw createInspectorCommandClientError(
        "invalid_request",
        "Missing required 'persona' string (a persona name or id)."
      );
    }
    const wanted = raw.trim();
    const wantedLower = wanted.toLowerCase();
    const matches = (personas ?? []).filter(
      (p) => p._id === wanted || p.name.toLowerCase() === wantedLower
    );
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) {
      throw createInspectorCommandClientError(
        "invalid_request",
        `No persona matches "${wanted}". Use a persona name or id from this screen (list them with ui_snapshot_app).`
      );
    }
    throw createInspectorCommandClientError(
      "invalid_request",
      `${matches.length} personas match "${wanted}" — pass the persona id instead (ids are in ui_snapshot_app).`
    );
  };

  const resolveJourney = (raw: unknown): Journey => {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw createInspectorCommandClientError(
        "invalid_request",
        "Missing required 'journey' string (a goal or journey id)."
      );
    }
    if (!selectedPersona) {
      throw createInspectorCommandClientError(
        "invalid_request",
        "Select a persona first — journeys are listed per persona (see ui_snapshot_app)."
      );
    }
    const wanted = raw.trim();
    const wantedLower = wanted.toLowerCase();
    const matches = (journeys ?? []).filter(
      (j) =>
        j._id === wanted ||
        j.goal.toLowerCase() === wantedLower ||
        (j.name ?? "").toLowerCase() === wantedLower
    );
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) {
      throw createInspectorCommandClientError(
        "invalid_request",
        `No journey matches "${wanted}" for persona "${selectedPersona.name}". Use a journey goal or id from this screen; if the journey belongs to another persona, select that persona first.`
      );
    }
    throw createInspectorCommandClientError(
      "invalid_request",
      `${matches.length} journeys match "${wanted}" — pass the journey id instead (ids are in ui_snapshot_app).`
    );
  };

  const hostTargetName = (id: string) =>
    hosts?.find((h) => h.hostId === id)?.name ?? id.slice(0, 8);

  useSurfaceAgentBridge({
    surfaceId: "swarms",
    handlers: {
      createPersona: async (command) => {
        requireAgentOperable();
        const pid = projectId;
        if (!pid) {
          throw createInspectorCommandClientError(
            "unsupported_in_mode",
            "No project is selected."
          );
        }
        const { payload } = command as CreatePersonaInspectorCommand;
        const name =
          typeof payload?.name === "string" ? payload.name.trim() : "";
        const role =
          typeof payload?.role === "string" ? payload.role.trim() : "";
        if (!name) {
          throw createInspectorCommandClientError(
            "invalid_request",
            "Missing required 'name' string."
          );
        }
        if (!role) {
          throw createInspectorCommandClientError(
            "invalid_request",
            "Missing required 'role' string."
          );
        }
        if (payload?.notes !== undefined && typeof payload.notes !== "string") {
          throw createInspectorCommandClientError(
            "invalid_request",
            "'notes' must be a string when provided."
          );
        }
        const notes =
          typeof payload?.notes === "string" ? payload.notes.trim() : "";
        // The SAME mutation the New-persona dialog calls; select the new row
        // just as the dialog's onCreate does.
        const row = await createPersona({
          projectId: pid,
          name,
          role,
          notes,
        } as any);
        setSelectedPersonaId(row._id);
        return {
          status: "persona_created",
          personaId: row._id,
          name,
          note: "The persona is now selected; add a journey with ui_open_journey_form.",
        };
      },
      openJourneyForm: async (command) => {
        requireAgentOperable();
        const { payload } = command as OpenJourneyFormInspectorCommand;
        let persona = selectedPersona;
        if (payload?.persona !== undefined) {
          persona = resolvePersona(payload.persona);
          setSelectedPersonaId(persona._id);
        }
        if (!persona) {
          throw createInspectorCommandClientError(
            "invalid_request",
            "Select or name a persona first — a journey belongs to a persona."
          );
        }
        if (payload?.goal !== undefined && typeof payload.goal !== "string") {
          throw createInspectorCommandClientError(
            "invalid_request",
            "'goal' must be a string when provided."
          );
        }
        const goal =
          typeof payload?.goal === "string" ? payload.goal.trim() : "";
        setJourneyGoalSeed(goal);
        setJourneyFormOpen(true);
        return {
          status: "form_opened",
          personaId: persona._id,
          ...(goal ? { prefilledGoal: goal } : {}),
          note: "The user picks environments and fan-out config and submits — no journey is created yet.",
        };
      },
      launchSwarmRun: async (command) => {
        requireAgentOperable();
        const pid = projectId;
        if (!pid) {
          throw createInspectorCommandClientError(
            "unsupported_in_mode",
            "No project is selected."
          );
        }
        const { payload } = command as LaunchSwarmRunInspectorCommand;
        const journey = resolveJourney(payload.journey);
        const jid = journey._id;
        void pid; // presence already validated above
        try {
          // ONE coordinator shared with the Run button — see launchJourney.
          const result = await launchJourney(jid);
          if (result.status === "already_launching") {
            throw createInspectorCommandClientError(
              "execution_failed",
              "This journey is already launching — wait for it to start."
            );
          }
          return {
            status: "run_requested",
            journeyId: jid,
            runId: result.runId,
            note: "The run fans out in the background; observe it with ui_snapshot_app.",
          };
        } catch (e) {
          if (e instanceof LaunchJourneyRunError) {
            if (e.status === 402) {
              throw createInspectorCommandClientError(
                "execution_failed",
                `Cannot launch this journey run: ${e.message} Launching spends the organization's swarm quota, which is exhausted — do not retry until it resets or billing is updated.`
              );
            }
            throw createInspectorCommandClientError(
              "execution_failed",
              `Could not launch the journey run: ${e.message}`
            );
          }
          throw e; // already an InspectorCommandClientError (e.g. already_launching)
        }
      },
    },
    // Redacted STATE, not payloads: persona/journey names + ids, host target
    // NAMES, and aggregate counters/scores only — no transcripts, no tokens,
    // no PII. Per-run session rows stay in the lazily-paginated per-run view.
    snapshot: () => {
      if (!agentOperable) {
        return {
          gated: true,
          reason: "Sign in and select a project to use Swarms.",
        };
      }
      return {
        selectedPersona: selectedPersona
          ? {
              id: selectedPersona._id,
              name: selectedPersona.name,
              role: selectedPersona.role,
            }
          : null,
        personaCount: personas?.length ?? 0,
        personas: (personas ?? [])
          .slice(0, AGENT_SNAPSHOT_MAX_PERSONAS)
          .map((p) => ({ id: p._id, name: p.name, role: p.role })),
        journeys: (journeys ?? [])
          .slice(0, AGENT_SNAPSHOT_MAX_JOURNEYS)
          .map((j) => ({
            id: j._id,
            goal: j.goal,
            name: j.name ?? null,
            hostTargets: j.hostIds.map(hostTargetName),
            sessionsPerHost: j.config.sessionsPerHost,
            maxTurns: j.config.maxTurns,
          })),
        trackRecord:
          trackRecord && trackRecord.sessionCount > 0
            ? {
                runCount: trackRecord.runCount,
                sessionCount: trackRecord.sessionCount,
                goalScore: trackRecord.goalScore
                  ? {
                      gradedCount: trackRecord.goalScore.gradedCount,
                      passedCount: trackRecord.goalScore.passedCount,
                      avgScore: trackRecord.goalScore.avgScore,
                    }
                  : null,
              }
            : null,
      };
    },
  });

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a project to manage swarms.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ErrorBoundary fallback={null}>
        <RunningPersonasSubscriber
          projectId={effectiveProjectId}
          onChange={onRunningPersonasChange}
        />
      </ErrorBoundary>
      <div
        className="relative shrink-0 border-b border-border/40 px-8 py-2.5"
        data-testid="swarms-tab-header-chrome"
      >
        <div className="flex min-w-0 items-center justify-center">
          <ViewModeSelector
            value={viewMode}
            ariaLabel="Swarm view"
            onChange={setViewMode}
            options={SWARM_VIEW_OPTIONS}
          />
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        {viewMode === "overview" ? (
          <main className="min-w-0 flex-1 overflow-hidden">
            <SwarmOverviewPanel
              projectId={effectiveProjectId}
              hasPersonas={
                personas === undefined ? undefined : personas.length > 0
              }
              onCreatePersona={() => void handleCreatePersona()}
              onOpenSession={handleOpenSessionDrilldown}
              onLaunchJourney={launchJourney}
            />
          </main>
        ) : viewMode === "journeys" ? (
          <>
            {/* Personas sidebar — Personas tab only */}
            <aside className="flex w-72 shrink-0 flex-col border-r">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <h2 className="text-sm font-semibold">Personas</h2>
                <div className="flex items-center gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label="Generate persona with AI"
                    onClick={() => setGenerateMode("persona")}
                  >
                    <Sparkles className="mr-1 size-3" />
                    Generate
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={creatingPersona}
                    onClick={() => void handleCreatePersona()}
                  >
                    {creatingPersona ? (
                      <Loader2 className="mr-1 size-3 animate-spin" />
                    ) : (
                      <Plus className="mr-1 size-3" />
                    )}
                    New
                  </Button>
                </div>
              </div>
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
                {personas === undefined ? (
                  <div className="p-4 text-sm text-muted-foreground">
                    Loading…
                  </div>
                ) : personas.length === 0 ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center">
                    <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/20">
                      <Users className="h-7 w-7 text-primary" />
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm font-semibold text-foreground">
                        No personas yet
                      </p>
                      <p className="max-w-xs text-xs text-muted-foreground">
                        Create a persona to simulate user journeys across your
                        clients.
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      className="font-semibold shadow-sm"
                      disabled={creatingPersona}
                      onClick={() => void handleCreatePersona()}
                    >
                      {creatingPersona ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Plus className="h-3.5 w-3.5" />
                      )}
                      Create your first persona
                    </Button>
                  </div>
                ) : (
                  personas.map((p) => {
                    const selected = p._id === selectedPersonaId;
                    return (
                      <div
                        key={p._id}
                        className={cn(
                          "group flex w-full items-center border-b",
                          selected && "bg-muted"
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => setSelectedPersonaId(p._id)}
                          className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left hover:bg-muted/50"
                        >
                          <PersonaPixelAvatar
                            seed={p._id}
                            shapeIndex={p.avatarShape}
                            paletteIndex={p.avatarPalette}
                            size="md"
                            state={runningSet.has(p._id) ? "running" : "idle"}
                          />
                          <span className="flex min-w-0 flex-col items-start gap-0.5">
                            <span className="truncate text-sm font-medium">
                              {p.name}
                            </span>
                            <span className="truncate text-xs text-muted-foreground">
                              {p.role}
                            </span>
                          </span>
                        </button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-label={`Delete ${p.name}`}
                          title="Delete persona"
                          className={cn(
                            "mr-2 size-8 shrink-0 p-0 text-muted-foreground hover:text-destructive",
                            selected
                              ? "opacity-100"
                              : "opacity-0 group-hover:opacity-100"
                          )}
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleDeletePersona(p);
                          }}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    );
                  })
                )}
              </div>
            </aside>

            {/* Persona detail + journey blocks; run detail opens on the right */}
            <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              {personas === undefined ? (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                  Loading…
                </div>
              ) : personas.length === 0 ? (
                <SwarmsEmptyHero
                  onCreatePersona={() => void handleCreatePersona()}
                />
              ) : !selectedPersona ? (
                <JourneyNetworkBackdrop />
              ) : (
                (() => {
                  const personaDetail = (
                    <>
                      <PersonaDetailHeader
                        persona={selectedPersona}
                        running={runningSet.has(selectedPersona._id)}
                        autoEditName={personaAutoEditId === selectedPersona._id}
                        onSave={(patch) =>
                          savePersonaField(selectedPersona._id, patch)
                        }
                        onDelete={() => handleDeletePersona(selectedPersona)}
                      />

                      <div
                        className={cn(
                          "mb-3",
                          journeyFormOpen
                            ? "space-y-2"
                            : "flex items-center justify-between"
                        )}
                      >
                        <h3 className="text-sm font-semibold">Journeys</h3>
                        {journeyFormOpen ? null : (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="ml-auto mr-1.5"
                            aria-label="Generate journeys with AI"
                            onClick={() => setGenerateMode("journeys")}
                          >
                            <Sparkles className="mr-1 size-3" />
                            Generate
                          </Button>
                        )}
                        <NewJourneyButton
                          projectId={projectId}
                          environments={environments}
                          open={journeyFormOpen}
                          onOpenChange={(o) => {
                            setJourneyFormOpen(o);
                            // Drop the agent prefill on close so a later manual
                            // open starts blank.
                            if (!o) setJourneyGoalSeed("");
                          }}
                          goalSeed={journeyGoalSeed}
                          onCreate={async (draft) => {
                            await createJourney({
                              projectId,
                              personaRefId: selectedPersona._id,
                              ...draft,
                            } as any);
                          }}
                        />
                      </div>

                      {journeys === undefined ? (
                        <div className="text-sm text-muted-foreground">
                          Loading…
                        </div>
                      ) : journeys.length === 0 ? (
                        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                          No journeys yet. A journey is a goal this persona
                          pursues across one or more hosts.
                        </div>
                      ) : (
                        <JourneyList
                          journeys={journeys}
                          hosts={hosts ?? []}
                          isAuthenticated={isAuthenticated}
                          projectId={projectId}
                          onLaunch={launchJourney}
                          initialRunId={deepLink.runId}
                          selection={runDetail}
                          onOpenRun={openRunDetail}
                          onCloseRun={closeRunDetail}
                          environments={environments}
                          environmentsEnabled={environmentsEnabled}
                        />
                      )}
                    </>
                  );

                  if (!runDetail || !detailJourney) {
                    return (
                      <div className="h-full overflow-y-auto">
                        <div className="mx-auto max-w-3xl px-8 py-6">
                          {personaDetail}
                        </div>
                      </div>
                    );
                  }
                  return (
                    <RunSessionsProvider
                      runId={runDetail.runId}
                      runSnapshot={runDetail.runSnapshot}
                      journeyRefId={runDetail.journeyId}
                      hosts={hosts ?? []}
                      sessionsPerHost={detailJourney.config.sessionsPerHost}
                      initialTargetKey={runDetail.targetKey}
                      initialThreadId={
                        deepLink.runId === runDetail.runId
                          ? deepLink.threadId
                          : undefined
                      }
                    >
                      <ResizablePanelGroup
                        direction="horizontal"
                        className="h-full"
                      >
                        <ResizablePanel defaultSize={38} minSize={26}>
                          <div className="h-full overflow-y-auto px-6 py-6">
                            {personaDetail}
                          </div>
                        </ResizablePanel>
                        <ResizableHandle withHandle />
                        <ResizablePanel defaultSize={62} minSize={35}>
                          <RunDetailPanel
                            key={`${runDetail.runId}:${
                              runDetail.targetKey ?? ""
                            }`}
                            journey={detailJourney}
                            onClose={closeRunDetail}
                          />
                        </ResizablePanel>
                      </ResizablePanelGroup>
                    </RunSessionsProvider>
                  );
                })()
              )}
            </main>
          </>
        ) : viewMode === "sessions" ? (
          <main className="min-w-0 flex-1 overflow-hidden">
            <SwarmsSessionsPanel
              projectId={projectId}
              personas={personas ?? []}
              hosts={hosts ?? []}
              personaRefId={sessionsPersonaFilter}
              onPersonaRefIdChange={setSessionsPersonaFilter}
              initialThreadId={drilldownThreadId ?? deepLink.threadId}
            />
          </main>
        ) : (
          <main className="min-w-0 flex-1 overflow-hidden">
            <SwarmInsightsPanel
              projectId={effectiveProjectId}
              onOpenSession={handleOpenSessionDrilldown}
            />
          </main>
        )}
      </div>
      {generateMode ? (
        <GenerateSwarmDialog
          mode={generateMode}
          open
          onOpenChange={(o) => {
            if (!o) setGenerateMode(null);
          }}
          projectId={projectId}
          environments={environments}
          personaCount={personas?.length}
          {...(selectedPersona
            ? {
                persona: {
                  _id: selectedPersona._id,
                  name: selectedPersona.name,
                  role: selectedPersona.role,
                  notes: selectedPersona.notes,
                },
              }
            : {})}
          onCreatePersona={async (draft) => {
            const row = await createPersona({
              projectId,
              source: "generated",
              ...draft,
            } as any);
            return row._id as string;
          }}
          onCreateJourney={async (personaRefId, draft) => {
            await createJourney({
              projectId,
              personaRefId,
              ...draft,
            } as any);
          }}
          onPersonaCreated={setSelectedPersonaId}
        />
      ) : null}
    </div>
  );
}

// ── run detail (right panel): header + sessions matrix + live stream ─────────
function RunDetailPanel({
  journey,
  onClose,
}: {
  journey: Journey;
  onClose: () => void;
}) {
  const runSessions = useRunSessionsContext();
  if (!runSessions) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading run…
      </div>
    );
  }

  const { run } = runSessions;
  const clientCount = run.hostSummaries.length || journey.hostIds.length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border/40 px-4 py-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-medium">
            <span>{runSessions.runLabel}</span>
            <span
              className={cn(
                "rounded-full px-1.5 py-px text-[10px] font-medium capitalize",
                runStatusChipClass(run.status)
              )}
            >
              {run.status.replace(/_/g, " ")}
            </span>
            <span className="min-w-0 truncate font-normal text-muted-foreground">
              {journey.goal}
            </span>
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
            <span>
              {clientCount} client{clientCount === 1 ? "" : "s"} ×{" "}
              {journey.config.sessionsPerHost} session
              {journey.config.sessionsPerHost === 1 ? "" : "s"}
            </span>
            <span aria-hidden>·</span>
            <span>{runSummaryLine(run)}</span>
            <span aria-hidden>·</span>
            <span>launched {formatJourneyRelativeTime(run.createdAt)}</span>
          </p>
        </div>
        <button
          type="button"
          aria-label="Close run detail"
          className="rounded-md p-1 text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onClose}
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <RunSessionsView
          personaRefId={journey.personaRefId}
          runId={run._id}
          goalScoreSummary={run.goalScoreSummary}
        />
      </div>
    </div>
  );
}

// ── live stream + session detail (per run; matrix lives in JourneyBlock) ────
function RunSessionsView({
  personaRefId,
  runId: scorecardRunId,
  goalScoreSummary,
}: {
  personaRefId: string;
  runId: string;
  goalScoreSummary?: GoalScoreRollup;
}) {
  const runSessions = useRunSessionsContext();
  const [detailSession, setDetailSession] = useState<JourneySessionRow | null>(
    null
  );
  const [sessionToPromote, setSessionToPromote] =
    useState<JourneySessionRow | null>(null);

  if (!runSessions) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading sessions…
      </div>
    );
  }

  const {
    runId,
    runStatus,
    sessionsStatus,
    loadMoreSessions,
    stream,
    matrixSelection,
    selectedConvex,
    fallbackTrace,
    autoFollowing,
  } = runSessions;

  useEffect(() => {
    setDetailSession(null);
  }, [matrixSelection?.chatSessionId]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4">
      {stream.connected || stream.error || sessionsStatus === "CanLoadMore" ? (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
          <p className="text-[10px] text-muted-foreground">
            {stream.connected ? "live" : null}
            {stream.error ? `stream error: ${stream.error}` : null}
          </p>
          {sessionsStatus === "CanLoadMore" ? (
            <button
              type="button"
              className="text-[11px] font-medium text-primary hover:underline"
              onClick={() => loadMoreSessions(DEFAULT_PAGE_SIZE)}
            >
              Load more sessions
            </button>
          ) : null}
        </div>
      ) : null}

      <RunScorecardSection
        runId={scorecardRunId}
        goalScoreSummary={goalScoreSummary}
      />

      <div className="flex min-h-[24rem] flex-1 flex-col">
        <SwarmLiveStreamPane
          selection={matrixSelection}
          stream={stream}
          convexSession={selectedConvex}
          fallbackTrace={fallbackTrace}
          runStatus={String(runStatus)}
          onOpenCompleted={(session) => setDetailSession(session)}
          fillHeight
          autoFollowing={autoFollowing}
        />
      </div>

      {detailSession ? (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-medium text-muted-foreground">
              Session detail
            </p>
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="text-[11px] font-medium text-primary hover:underline"
                onClick={() => setSessionToPromote(detailSession)}
              >
                Promote to test case
              </button>
              <button
                type="button"
                className="text-[11px] text-muted-foreground hover:underline"
                onClick={() => setDetailSession(null)}
              >
                Close
              </button>
            </div>
          </div>
          <div className="h-[420px] overflow-hidden rounded-lg border">
            <ShareUsageThreadDetail
              threadId={detailSession.id}
              sessionLink={`${getShareableAppOrigin()}${buildSwarmSessionPath({
                personaRefId,
                runId,
                hostId: detailSession.hostId,
                threadId: detailSession.id,
              })}`}
            />
          </div>
        </div>
      ) : null}

      <ConvertSwarmSessionDialog
        open={sessionToPromote !== null}
        session={sessionToPromote}
        onOpenChange={(open) => {
          if (!open) {
            setSessionToPromote(null);
          }
        }}
        onImported={({ suiteId, testCaseId }) => {
          setSessionToPromote(null);
          navigateApp(
            buildEvalsPath({
              type: "test-edit",
              suiteId,
              testId: testCaseId,
            })
          );
        }}
      />
    </div>
  );
}

// ── persona detail (evals-style editable header) ─────────────────────────────

function PersonaDetailHeader({
  persona,
  running,
  autoEditName = false,
  onSave,
  onDelete,
}: {
  persona: Persona;
  running: boolean;
  autoEditName?: boolean;
  onSave: (patch: {
    name?: string;
    role?: string;
    notes?: string;
    avatarShape?: number;
    avatarPalette?: number;
  }) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [notes, setNotes] = useState(persona.notes ?? "");

  useEffect(() => {
    setNotes(persona.notes ?? "");
  }, [persona._id, persona.notes]);

  const persistNotes = async () => {
    const next = notes.trim();
    const prev = (persona.notes ?? "").trim();
    if (next === prev) return;
    try {
      await onSave({ notes: next });
    } catch {
      setNotes(persona.notes ?? "");
    }
  };

  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <PersonaAvatarLookPicker
          seed={persona._id}
          avatarShape={persona.avatarShape}
          avatarPalette={persona.avatarPalette}
          state={running ? "running" : "idle"}
          onSave={(look) => onSave(look)}
        />
        <div className="min-w-0 flex-1">
          <EditableTitle
            value={persona.name}
            onSave={(name) => onSave({ name })}
            startInEditMode={autoEditName}
            variant="h2"
            fullWidth
            truncate={false}
            placeholder="Persona name"
            className="-ml-2 px-2 text-lg font-semibold tracking-tight sm:text-xl"
            inputClassName="text-lg font-semibold tracking-tight sm:text-xl"
          />
          <EditableTitle
            value={persona.role}
            onSave={(role) => onSave({ role })}
            variant="text"
            fullWidth
            truncate={false}
            placeholder="Role"
            className="-ml-2 mt-0.5 px-2 font-normal text-muted-foreground"
            inputClassName="font-normal text-muted-foreground"
          />
          <TextareaAutosize
            aria-label="Notes / personality"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => void persistNotes()}
            minRows={1}
            maxRows={4}
            placeholder="Add personality notes…"
            className={cn(
              "mt-2 min-h-0 resize-none border-0 bg-transparent px-0 py-0 text-sm",
              "text-muted-foreground shadow-none placeholder:text-muted-foreground/60",
              "focus-visible:border-0 focus-visible:ring-0"
            )}
          />
        </div>
      </div>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="shrink-0 text-muted-foreground hover:text-destructive"
        onClick={() => void onDelete()}
      >
        Delete persona
      </Button>
    </div>
  );
}

function NewJourneyButton({
  projectId,
  environments,
  onCreate,
  open,
  onOpenChange,
  goalSeed,
}: {
  projectId: string;
  /** Live project environments — `undefined` while loading, `[]` when none. */
  environments: ProjectEnvironmentView[] | undefined;
  onCreate: (draft: {
    goal: string;
    hostIds: string[];
    /** Ordered fan-out; compat hostIds ride alongside. */
    environmentIds: string[];
    config: { sessionsPerHost: number; maxTurns: number };
    judgeConfig?: GoalJudgeConfig;
    /** Deterministic criteria. Omitted when the author added none. */
    rubric?: JourneyCriterion[];
  }) => Promise<void>;
  // Controlled by SwarmsTab so `ui_open_journey_form` can open + prefill it.
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Goal to seed each time the form opens ("" for a manual open). */
  goalSeed: string;
}) {
  const [goal, setGoal] = useState("");
  const envList = useMemo(() => environments ?? [], [environments]);
  const [environmentIds, setEnvironmentIds] = useState<string[]>([]);
  const [sessionsPerHost, setSessionsPerHost] = useState(2);
  const [maxTurns, setMaxTurns] = useState(6);
  // Judge config is hidden behind "Advanced" — progressive discovery. Default
  // undefined = managed defaults (auto-grade off) until the user opts in.
  const [judgeConfig, setJudgeConfig] = useState<GoalJudgeConfig | undefined>(
    undefined
  );
  // Deterministic criteria, authored beside the judge. Empty = ungraded, which
  // is a different state from "graded and everything passed" — the form never
  // sends an empty rubric.
  const [rubric, setRubric] = useState<JourneyCriterion[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const { availableModels } = useAvailableModels({ projectId });
  // Seed the goal from the agent prefill (or reset to "") whenever the form
  // transitions open. Manual "+ New journey" opens pass goalSeed="".
  useEffect(() => {
    if (open) {
      setGoal(goalSeed);
      setJudgeConfig(undefined);
      setRubric([]);
      setAdvancedOpen(false);
      setEnvironmentIds([]);
    }
  }, [open, goalSeed]);
  const setOpen = onOpenChange;
  const envPayload = buildEnvJourneyPayload(environmentIds, envList);
  const rubricValid = areAllChecksValid(rubric.map((entry) => entry.predicate));

  if (!open) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
      >
        <Plus className="mr-1 size-3" />
        New journey
      </Button>
    );
  }
  return (
    <div
      className={cn(
        "w-full rounded-xl border border-border/50 bg-card/50 p-3 shadow-sm",
        "ring-1 ring-black/[0.03] dark:ring-white/[0.06]"
      )}
    >
      <div className="mb-2.5 flex flex-col gap-1">
        <Label htmlFor="swarm-journey-goal" className="text-xs">
          Goal
        </Label>
        <Textarea
          id="swarm-journey-goal"
          placeholder="What this persona is trying to accomplish"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={2}
          className="min-h-[56px] resize-none leading-relaxed"
        />
      </div>

      <div className="mb-2.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2">
        <EnvironmentPicker
          projectId={projectId}
          value={environmentIds}
          onChange={setEnvironmentIds}
          multi
          max={MAX_ENVIRONMENTS_PER_JOURNEY}
          emptyLabel="No environments · pick one"
          triggerTestId="journey-environments-picker"
          triggerAriaLabel="Attached environments"
        />
      </div>

      <div className="mb-2.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Label
          htmlFor="swarm-journey-sessions"
          className="shrink-0 text-[11px] text-muted-foreground"
        >
          Sessions
        </Label>
        <Input
          id="swarm-journey-sessions"
          type="number"
          min={1}
          max={5}
          className="h-8 w-14"
          value={sessionsPerHost}
          onChange={(e) => setSessionsPerHost(Number(e.target.value))}
        />
        <Label
          htmlFor="swarm-journey-turns"
          className="ml-1 shrink-0 text-[11px] text-muted-foreground"
        >
          Turns
        </Label>
        <Input
          id="swarm-journey-turns"
          type="number"
          min={1}
          max={20}
          className="h-8 w-14"
          value={maxTurns}
          onChange={(e) => setMaxTurns(Number(e.target.value))}
        />
      </div>

      {/* Advanced → Judge. Hidden by default (progressive discovery); the
          JudgesSection is the same control the eval suite settings use. */}
      <div className="mb-2.5 border-t border-border/40 pt-2">
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
          aria-expanded={advancedOpen}
        >
          <ChevronDown
            className={cn(
              "size-3 transition-transform",
              advancedOpen && "rotate-180"
            )}
          />
          Advanced
        </button>
        {advancedOpen ? (
          <div className="mt-2">
            <JudgesSection
              chrome="bare"
              value={judgeConfig}
              onChange={setJudgeConfig}
              availableModels={availableModels}
              bareAutoGradeBlurb="Grade every session automatically against this journey's goal. Uses credits. You can also judge any session on demand from its detail view."
              bareAutoGradeAriaLabel="Auto-grade every session with LLM as Judge"
            />
            {/* Deterministic criteria sit BESIDE the judge, not under it: they
                answer a different question (did the run satisfy these specific
                rules?) and cost nothing to run. */}
            <div className="mt-3 border-t border-border/40 pt-3">
              <JourneyRubricEditor value={rubric} onChange={setRubric} />
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={
            !goal.trim() ||
            envPayload === null ||
            !Number.isInteger(sessionsPerHost) ||
            sessionsPerHost < 1 ||
            sessionsPerHost > 5 ||
            !Number.isInteger(maxTurns) ||
            maxTurns < 1 ||
            maxTurns > 20 ||
            // A half-finished criterion (a freshly added row with a blank tool
            // name, say) would be rejected by the backend validator and lose
            // the whole journey. `ChecksSection` renders the per-row error, but
            // that validity never reaches this form — so gate on it here.
            !rubricValid
          }
          onClick={async () => {
            if (!envPayload) return;
            await onCreate({
              goal,
              hostIds: envPayload.hostIds,
              environmentIds: envPayload.environmentIds,
              config: { sessionsPerHost, maxTurns },
              ...(judgeConfig ? { judgeConfig } : {}),
              // Empty ⇒ omit. Sending `[]` would persist "rubric configured,
              // zero rows", which reads as graded-with-nothing rather than
              // ungraded.
              ...(rubric.length > 0
                ? { rubric: serializeRubricForWire(rubric) }
                : {}),
            });
            setOpen(false);
            setGoal("");
            setEnvironmentIds([]);
            setJudgeConfig(undefined);
            setRubric([]);
          }}
        >
          Create journey
        </Button>
      </div>
    </div>
  );
}
