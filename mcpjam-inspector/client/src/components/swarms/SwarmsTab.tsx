/**
 * Project-scoped Swarms surface (redesign): Persona → Journey → Run.
 *
 * Replaces the old host-anchored `ScenariosTab product="swarm"`. Personas and
 * journeys live at the project level; a journey targets one-or-more hosts and,
 * when run, fans out one single-host session per (host × sessionsPerTarget).
 *
 * Top-level views (ViewModeSelector) on `/swarms`. Overview is the landing tab;
 * a deep link naming a session or a run overrides it, because those name a place:
 *   - Overview — Swarm Runs list; row click opens `/swarms/:swarmId`
 *   - Personas — persona sidebar, journey cards, run matrix / live stream
 *   - Sessions — flat chatSessions browser with top-bar persona filter
 *     (`listSessionsByPersona` + shared ShareUsageThreadList/Detail)
 *
 * `/swarms/:swarmId` renders a dedicated Swarm Run detail (Insights / Sessions
 * scoped to that wave) instead of the list header. Per-wave Insights owns the
 * session-flow Sankey; there is no project-wide Insights tab.
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
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";
import { toast } from "@/lib/toast";
import { isNamedEnvironment } from "@/lib/environment-label";
import { cn } from "@/lib/utils";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { TextareaAutosize } from "@/components/ui/textarea-autosize";
import { PersonaPixelAvatar } from "@/components/swarms/persona-pixel-avatar";
import { PersonaAvatarLookPicker } from "@/components/swarms/persona-avatar-look-picker";
import { SectionLabel } from "@/components/shared/section-label";
import { JourneyNetworkBackdrop } from "@/components/swarms/journey-network-backdrop";
import { SwarmsEmptyHero } from "@/components/swarms/swarms-empty-hero";
import {
  launchJourneyRun,
  LaunchJourneyRunError,
  SWARM_QUERIES,
  type PersonaTrackRecord,
} from "@/lib/swarm-api";
import {
  useCreateProjectEnvironment,
  type ProjectEnvironmentView,
} from "@/hooks/useProjectEnvironments";
import {
  buildEnvJourneyPayload,
  MAX_ENVIRONMENTS_PER_JOURNEY,
} from "@/components/swarms/journey-environments";
import { EnvironmentPicker } from "@/components/project-environments/environment-picker";
import { shouldQueryProjectId } from "@/hooks/useProjects";
// The badge + wide-shape guard live in the shared session-quality module so
// surfaces rendered inside this subtree can use them without an import cycle.
// Re-exported here because the goal-score unit test imports from `../SwarmsTab`.
export {
  SessionGoalScoreBadge,
  toSessionGoalScore,
} from "@/components/shared/session-quality/session-goal-score-badge";
import { JudgesSection } from "@/components/evals/judges-section";
import { JourneyRubricEditor } from "@/components/swarms/journey-rubric-editor";
import { areAllChecksValid } from "@/components/evals/checks-section";
import {
  serializeRubricForWire,
  type JourneyCriterion,
} from "@/shared/journey-rubric";
import { useAvailableModels } from "@/hooks/use-available-models";
import type { GoalJudgeConfig } from "@/components/shared/session-quality/judge-config";
import {
  buildSwarmPath,
  parseSwarmSessionParams,
  routePaths,
  swarmsCreatePath,
  useAppNavigate,
} from "@/lib/app-navigation";
import { SwarmsSessionsPanel } from "@/components/swarms/SwarmsSessionsPanel";
import { SwarmOverviewPanel } from "@/components/swarms/swarm-overview-panel";
import { SwarmRunDetail } from "@/components/swarms/swarm-run-detail";
import { PersonaGoalList } from "@/components/swarms/persona-goal-list";
import { GenerateSwarmDialog } from "@/components/swarms/GenerateSwarmDialog";
import { NewSwarmCreateFlow } from "@/components/swarms/new-swarm-create-flow";
// Re-exported for the goal-score unit test, which imports from `../SwarmsTab`.
export { goalScoreAvgLabel } from "@/components/swarms/journey-run-format";
import {
  SwarmsTabHeader,
  type SwarmViewMode,
} from "@/components/swarms/swarms-tab-header";
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

/** Above this, the library is long enough that scanning it needs a filter. */
const SEARCHABLE_PERSONA_COUNT = 5;
const AGENT_SNAPSHOT_MAX_JOURNEYS = 30;

const SWARM_VIEW_OPTIONS = [
  { value: "overview" as const, label: "Overview" },
  { value: "journeys" as const, label: "Personas" },
  { value: "sessions" as const, label: "Sessions" },
] as const;

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
  config: { sessionsPerTarget: number; maxTurns: number };
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
  /**
   * When set (from `/swarms/:swarmId`), render the Swarm Run detail instead of
   * the list header + view modes. Optional so unit tests can mount without a
   * router.
   */
  swarmId?: string | null;
  /**
   * When true (from `/swarms/new`), render the full-page create flow. A route
   * rather than in-page state so the flow is linkable and the browser back
   * button leaves it — the same durable-path shape User Testing uses.
   */
  createFlow?: boolean;
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
/**
 * Live project environments for swarm create/generate (environments-only).
 *
 * NOTE this is a RAW `useQuery`, deliberately not `useProjectEnvironments` —
 * it predates that hook's auth/db-ready gate and feeds four consumers here. It
 * is therefore the one list site an `includeAdhoc` option on the hook cannot
 * protect, so the NAMED-only filter is applied explicitly below. Everything
 * this feeds — the castle picker, the journey environments popover — offers
 * environments a human chose to name; ad-hoc rows would flood them.
 *
 * The backend's own named-only default already covers this, and the filter is
 * redundant with it on purpose: the two protect different failure modes.
 */
function useProjectEnvironmentsList(projectId: string | null) {
  const rows = useQuery(
    SWARM_QUERIES.listEnvironments as any,
    // `shouldQueryProjectId` (not a bare truthiness check): a local/placeholder
    // or UUID project id during a project transition would 500 the Convex arg
    // validator, so skip until the id is a real queryable project.
    shouldQueryProjectId(projectId) ? ({ projectId } as any) : "skip"
  ) as ProjectEnvironmentView[] | undefined;
  return useMemo(
    () => (rows === undefined ? undefined : rows.filter(isNamedEnvironment)),
    [rows]
  );
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

export function SwarmsTab({
  projectId,
  isAuthenticated,
  swarmId: swarmIdProp = null,
  createFlow = false,
}: SwarmsTabProps) {
  // Don't subscribe to project-scoped Convex reads until auth is ready — a
  // signed-out/loading mount with a persisted project would otherwise surface
  // authorization errors instead of holding the screen.
  const effectiveProjectId = isAuthenticated ? projectId : null;
  const navigate = useAppNavigate();
  const swarmId = swarmIdProp?.trim() ? swarmIdProp : null;
  const personas = usePersonas(effectiveProjectId);
  const hosts = useProjectHosts(effectiveProjectId);
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
  // Session AND run deep-links open the flat Sessions browser: it is the only
  // surface that still reads a run, and it takes the run as a filter
  // (`journeyRunIds`) rather than dropping it. A persona-only link opens the
  // library. Everything else starts on the Overview.
  const [viewMode, setViewMode] = useState<SwarmViewMode>(() => {
    if (deepLink.threadId || deepLink.runId) return "sessions";
    if (deepLink.personaRefId) return "journeys";
    // `?view=` is how leaving the create flow names its landing view, so a
    // reload of that URL lands in the same place.
    const requested = new URLSearchParams(window.location.search).get("view");
    if (requested === "sessions" || requested === "journeys") return requested;
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
  const handleOpenSwarm = useCallback(
    (id: string) => {
      navigate(buildSwarmPath(id));
    },
    [navigate]
  );
  const journeys = useJourneys(selectedPersonaId);
  // Lifted for the agent snapshot (one subscription).

  const createPersona = useMutation("personas:createPersona" as any);
  const updatePersona = useMutation("personas:updatePersona" as any);
  const deletePersona = useMutation("personas:deletePersona" as any);
  const createJourney = useMutation("journeys:createJourney" as any);
  /** Authoring container written once per New-swarm run (see `swarms.ts`). */
  const createSwarm = useMutation("swarms:createSwarm" as any);
  const updateJourney = useMutation("journeys:updateJourney" as any);
  const archiveJourney = useMutation("journeys:archiveJourney" as any);
  /** Project-wide clustering settings, saved before anything has clustered. */
  const setInsightsTuning = useMutation(
    "chatSessions:setSwarmInsightsTuning" as any
  );
  const createEnvironment = useCreateProjectEnvironment();
  const hostNameById = useCallback(
    (hostId: string) =>
      hosts?.find((host) => host.hostId === hostId)?.name ?? hostId.slice(0, 8),
    [hosts]
  );

  // The create flow is route-driven (`createFlow`), not state.
  // Human labels for the runs the create flow just launched, so the sessions
  // view groups them under "Persona · Journey" instead of a run id suffix.
  // Empty for every run this session didn't launch — those keep the id label.
  const [swarmRunLabels, setSwarmRunLabels] = useState<Map<string, string>>(
    () => new Map()
  );

  // AI generation ("Generate persona" / "Generate journeys"). Both write real
  // rows through the mutations above; running them stays a separate click.
  // New swarm has its own route; this dialog remains for Personas sidebar
  // Generate and "Generate journeys".
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
          `Delete persona "${persona.name}"? Its goals are hidden but historical runs are kept.`
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

  /**
   * Remove one goal from the persona. Archives rather than hard-deletes, which
   * is what `journeys:archiveJourney` does — the runs that goal already
   * produced stay readable from Overview and Sessions.
   */
  const handleDeleteJourney = useCallback(
    async (journey: { _id: string; goal: string }) => {
      if (
        !window.confirm(
          `Delete goal "${journey.goal}"? Runs it already produced are kept.`
        )
      ) {
        return;
      }
      try {
        await archiveJourney({ journeyRefId: journey._id } as any);
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to delete goal"
        );
      }
    },
    [archiveJourney]
  );

  const selectedPersona = useMemo(
    () => personas?.find((p) => p._id === selectedPersonaId) ?? null,
    [personas, selectedPersonaId]
  );

  /**
   * Personas library search (BB-123). Filters the rail only — the selection
   * survives a search that hides it, so typing never silently swaps which
   * persona the editor (or the agent bridge) is pointed at.
   */
  const [personaSearch, setPersonaSearch] = useState("");
  const personaList = useMemo(() => personas ?? [], [personas]);
  const visiblePersonas = useMemo(() => {
    const query = personaSearch.trim().toLowerCase();
    if (!query) return personaList;
    return personaList.filter(
      (persona) =>
        persona.name.toLowerCase().includes(query) ||
        persona.role.toLowerCase().includes(query)
    );
  }, [personaList, personaSearch]);

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
  //
  // The wave id is retained ALONGSIDE the key, not separately: a replayed
  // launchKey returns the run the backend already created, carrying the wave it
  // was first stamped with. Minting a fresh wave id on retry would therefore
  // claim a grouping the stored run does not have.
  const launchKeysRef = useRef<
    Map<string, { launchKey: string; swarmRunGroupId?: string }>
  >(new Map());
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
      journeyId: string,
      /**
       * `swarmRunGroupId` groups this launch with its siblings. The create
       * flow mints ONE per wave and passes it for every journey; solo callers
       * (Run, Run again, `ui_launch_swarm_run`) pass nothing and get a fresh
       * id — each of those launches exactly one journey, so a wave of one is
       * the correct grouping, and it retires the time heuristic for them too.
       */
      opts?: { swarmRunGroupId?: string; environmentIds?: string[] }
    ): Promise<
      { status: "launched"; runId?: string } | { status: "already_launching" }
    > => {
      if (!projectId) {
        throw new LaunchJourneyRunError(0, "No project is selected.");
      }
      if (launchingRef.current.has(journeyId)) {
        return { status: "already_launching" };
      }
      let pending = launchKeysRef.current.get(journeyId);
      if (!pending) {
        pending = {
          launchKey: crypto.randomUUID(),
          swarmRunGroupId: opts?.swarmRunGroupId ?? crypto.randomUUID(),
        };
        launchKeysRef.current.set(journeyId, pending);
      }
      launchingRef.current.add(journeyId);
      try {
        const result = await launchJourneyRun({
          journeyId,
          projectId,
          launchKey: pending.launchKey,
          ...(pending.swarmRunGroupId
            ? { swarmRunGroupId: pending.swarmRunGroupId }
            : {}),
          // Per-launch fan-out. NOT cached with the launch key: unlike the
          // wave id, this isn't an identity the backend already committed —
          // a replayed launchKey returns the existing run and ignores it.
          ...(opts?.environmentIds?.length
            ? { environmentIds: opts.environmentIds }
            : {}),
        });
        launchKeysRef.current.delete(journeyId); // confirmed 2xx
        return { status: "launched", runId: result.runId };
      } finally {
        // Retain the key (and its wave) on failure (handled by the thrown error
        // reaching the caller); only clear the in-flight marker.
        launchingRef.current.delete(journeyId);
      }
    },
    [projectId]
  );

  const handleRunAgainFromDetail = useCallback(
    async (journeyRefIds: string[]) => {
      const swarmRunGroupId = crypto.randomUUID();
      const errors: string[] = [];
      for (const journeyId of journeyRefIds) {
        try {
          const result = await launchJourney(journeyId, { swarmRunGroupId });
          if (result.status === "already_launching") continue;
        } catch (err) {
          errors.push(
            err instanceof LaunchJourneyRunError
              ? err.message
              : err instanceof Error
              ? err.message
              : "Launch failed"
          );
        }
      }
      if (errors.length > 0) {
        throw new Error(errors[0]!);
      }
    },
    [launchJourney]
  );
  const handleOpenPersonaFromDetail = useCallback(
    (personaName: string) => {
      const match = (personas ?? []).find(
        (p) => p.name.toLowerCase() === personaName.toLowerCase()
      );
      if (match) setSelectedPersonaId(match._id);
      setViewMode("journeys");
      navigate(routePaths.swarms);
    },
    [navigate, personas]
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
        "Missing required 'journey' string (goal text or goal id)."
      );
    }
    if (!selectedPersona) {
      throw createInspectorCommandClientError(
        "invalid_request",
        "Select a persona first — goals are listed per persona (see ui_snapshot_app)."
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
        `No goal matches "${wanted}" for persona "${selectedPersona.name}". Use a goal text or id from this screen; if the goal belongs to another persona, select that persona first.`
      );
    }
    throw createInspectorCommandClientError(
      "invalid_request",
      `${matches.length} goals match "${wanted}" — pass the goal id instead (ids are in ui_snapshot_app).`
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
          note: "The persona is now selected; add a goal with ui_open_journey_form.",
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
            "Select or name a persona first — a goal belongs to a persona."
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
          note: "The user picks environments and fan-out config and submits — no goal is created yet.",
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
              "This goal is already launching — wait for it to start."
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
                `Cannot launch this goal run: ${e.message} Launching spends the organization's swarm quota, which is exhausted — do not retry until it resets or billing is updated.`
              );
            }
            throw createInspectorCommandClientError(
              "execution_failed",
              `Could not launch the goal run: ${e.message}`
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
            sessionsPerTarget: j.config.sessionsPerTarget,
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

  if (createFlow && projectId) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <ErrorBoundary fallback={null}>
          <RunningPersonasSubscriber
            projectId={effectiveProjectId}
            onChange={onRunningPersonasChange}
          />
        </ErrorBoundary>
        <NewSwarmCreateFlow
          projectId={projectId}
          environments={environments}
          hostNameById={hostNameById}
          createEnvironment={createEnvironment}
          personas={personas}
          onCreateSwarm={async (draft) => {
            const row = await createSwarm({ projectId, ...draft } as any);
            return row._id as string;
          }}
          onCreatePersona={async (draft) => {
            const row = await createPersona({
              projectId,
              source: "generated",
              ...draft,
            } as any);
            return row._id as string;
          }}
          onCreateJourney={async (personaRefId, draft) => {
            const row = await createJourney({
              projectId,
              personaRefId,
              ...draft,
            } as any);
            return row._id as string;
          }}
          onUpdateJourney={async (journeyRefId, patch) => {
            // Spread the patch as-is: every field is optional and an OMITTED
            // field must stay omitted on the wire. `updateJourney` treats
            // `null` as "clear", so sending an explicit undefined-turned-null
            // judgeConfig would wipe the journey's own judge.
            await updateJourney({ journeyRefId, ...patch } as any);
          }}
          launchJourney={launchJourney}
          onCancel={() => navigate(routePaths.swarms)}
          onDone={(runLabels) => {
            // Labels are component state and `/swarms/new` → `/swarms` swaps
            // sibling routes without remounting this component, so they
            // survive. `?view=sessions` carries the landing view in the URL
            // regardless, so a remount (or a reload) still lands correctly —
            // it just falls back to run-id labels.
            setSwarmRunLabels(runLabels);
            setViewMode("sessions");
            navigate(`${routePaths.swarms}?view=sessions`);
          }}
          onOpenSession={({ sessionId, swarmRunGroupId, runLabels }) => {
            setSwarmRunLabels(runLabels);
            if (swarmRunGroupId) {
              // The wave's own page, on the session that produced the finding.
              // It is a real URL, so this leave is reversible — and the run
              // keeps streaming into that page while the user reads.
              navigate(
                buildSwarmPath(swarmRunGroupId, {
                  tab: "sessions",
                  session: sessionId,
                })
              );
              return;
            }
            // No wave id means nothing launched under one, so there is no run
            // page to open — fall back to the handoff `onDone` already makes.
            setViewMode("sessions");
            navigate(`${routePaths.swarms}?view=sessions`);
          }}
          // Raw, NOT `savePersonaField`: that helper toasts and rethrows for
          // the Personas library, where its toast is the only error surface.
          // Confirm owns the message for its own panel, so routing through it
          // would show the same error twice.
          onSaveExistingPersona={async (personaRefId, patch) => {
            await updatePersona({ personaRefId, ...patch } as any);
          }}
          onSetInsightsTuning={async (tuning) => {
            await setInsightsTuning({ projectId, tuning } as any);
          }}
        />
      </div>
    );
  }

  if (swarmId) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <ErrorBoundary fallback={null}>
          <RunningPersonasSubscriber
            projectId={effectiveProjectId}
            onChange={onRunningPersonasChange}
          />
        </ErrorBoundary>
        <SwarmRunDetail
          swarmId={swarmId}
          projectId={effectiveProjectId}
          personas={personas ?? []}
          hosts={hosts ?? []}
          onRunAgain={handleRunAgainFromDetail}
          onOpenPersona={handleOpenPersonaFromDetail}
        />
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
      <SwarmsTabHeader
        projectId={effectiveProjectId}
        viewMode={viewMode}
        viewOptions={SWARM_VIEW_OPTIONS}
        onViewModeChange={setViewMode}
        creatingSwarm={creatingPersona}
        onNewSwarm={() => navigate(swarmsCreatePath)}
      />
      <div className="flex min-h-0 flex-1">
        {viewMode === "overview" ? (
          <main className="min-w-0 flex-1 overflow-hidden">
            <SwarmOverviewPanel
              projectId={effectiveProjectId}
              hasPersonas={
                personas === undefined ? undefined : personas.length > 0
              }
              onNewSwarm={() => navigate(swarmsCreatePath)}
              onOpenSwarm={handleOpenSwarm}
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
              {/* Only once the list is long enough to hunt through — a search
                  box over three rows is furniture, not a tool. Kept while a
                  query is active regardless: deleting a persona can drop the
                  list under the threshold, and hiding the input then would
                  leave the filter applied with nothing to clear it. */}
              {personaList.length > SEARCHABLE_PERSONA_COUNT ||
              personaSearch.trim().length > 0 ? (
                <div className="border-b px-3 py-2">
                  <Input
                    value={personaSearch}
                    onChange={(event) => setPersonaSearch(event.target.value)}
                    placeholder="Search personas…"
                    aria-label="Search personas"
                    className="h-8"
                    data-testid="swarm-persona-search"
                  />
                </div>
              ) : null}
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
                        No saved personas yet
                      </p>
                      <p className="max-w-xs text-xs text-muted-foreground">
                        Personas you save here are the ones you send into
                        swarms.
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
                      Create a persona
                    </Button>
                  </div>
                ) : visiblePersonas.length === 0 ? (
                  <p
                    className="p-4 text-sm text-muted-foreground"
                    data-testid="swarm-persona-search-empty"
                  >
                    No personas match &ldquo;{personaSearch.trim()}&rdquo;.
                  </p>
                ) : (
                  visiblePersonas.map((p) => {
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

            {/* Persona detail: identity + context editor, then its goals */}
            <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              {personas === undefined ? (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                  Loading…
                </div>
              ) : personas.length === 0 ? (
                <SwarmsEmptyHero
                  onNewSwarm={() => navigate(swarmsCreatePath)}
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
                        <SectionLabel>Goals</SectionLabel>
                        {journeyFormOpen ? null : (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="ml-auto mr-1.5"
                            aria-label="Generate goals with AI"
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
                          No goals yet. A goal is what this persona pursues
                          across one or more hosts.
                        </div>
                      ) : (
                        <PersonaGoalList
                          journeys={journeys}
                          onDelete={handleDeleteJourney}
                        />
                      )}
                    </>
                  );

                  return (
                    <div className="h-full overflow-y-auto">
                      <div className="mx-auto max-w-3xl px-8 py-6">
                        {personaDetail}
                      </div>
                    </div>
                  );
                })()
              )}
            </main>
          </>
        ) : (
          <main className="min-w-0 flex-1 overflow-hidden">
            <SwarmsSessionsPanel
              projectId={projectId}
              personas={personas ?? []}
              hosts={hosts ?? []}
              personaRefId={sessionsPersonaFilter}
              onPersonaRefIdChange={setSessionsPersonaFilter}
              initialThreadId={deepLink.threadId}
              runLabels={swarmRunLabels}
              journeyRunIds={
                deepLink.runId ? [deepLink.runId] : undefined
              }
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

// ── persona detail (evals-style editable header) ─────────────────────────────

/**
 * Persona identity + context editor for the Personas library.
 *
 * Mirrors the field groups Confirm personas uses — identity, Persona, Use cases
 * & context — so a persona reads the same in the library as it does mid-flow
 * (BB-123). Goals follow below, owned by the caller.
 *
 * No Save button: every field commits on blur, which is what "direct fields"
 * means here and matches how notes already behaved. A field that failed to
 * save rolls back to the stored value rather than showing a phantom edit.
 * `Delete persona` is the only button, since it is the one action that is not
 * an edit.
 */
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
  const [name, setName] = useState(persona.name);
  const [role, setRole] = useState(persona.role);
  const [notes, setNotes] = useState(persona.notes ?? "");

  // Re-seed when the selection changes, or when the stored row moves under us
  // (another tab, or the AI generator writing into this persona).
  useEffect(() => {
    setName(persona.name);
  }, [persona._id, persona.name]);
  useEffect(() => {
    setRole(persona.role);
  }, [persona._id, persona.role]);
  useEffect(() => {
    setNotes(persona.notes ?? "");
  }, [persona._id, persona.notes]);

  /**
   * Commit one field on blur. Compares trimmed values so whitespace-only
   * churn never writes, and rolls the local value back if the write throws —
   * leaving the edit on screen would claim a save that did not happen.
   *
   * The rollback is guarded by a per-field sequence number. Blur, edit again,
   * blur again before the first write settles, and a late failure from the
   * FIRST would otherwise reset the field to the stale stored value and throw
   * away the newer edit — the exact loss the rollback exists to prevent.
   */
  const commitSeqRef = useRef<Record<string, number>>({});
  const commit = async (
    field: "name" | "role" | "notes",
    next: string,
    stored: string,
    reset: (value: string) => void
  ) => {
    const trimmed = next.trim();
    if (trimmed === stored.trim()) return;
    // A persona needs a name; an emptied field is a slip, not an intent.
    if (field === "name" && trimmed.length === 0) {
      reset(stored);
      return;
    }
    const seq = (commitSeqRef.current[field] ?? 0) + 1;
    commitSeqRef.current[field] = seq;
    try {
      await onSave({ [field]: trimmed });
    } catch {
      // Stale failure: a newer commit for this field has already started, and
      // its value is what is on screen.
      if (commitSeqRef.current[field] !== seq) return;
      reset(stored);
    }
  };

  return (
    <div className="mb-5 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <PersonaAvatarLookPicker
            seed={persona._id}
            avatarShape={persona.avatarShape}
            avatarPalette={persona.avatarPalette}
            state={running ? "running" : "idle"}
            onSave={(look) => onSave(look)}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xl font-semibold tracking-tight text-foreground">
              {persona.name}
            </p>
            {persona.role ? (
              <p className="truncate text-sm text-muted-foreground">
                {persona.role}
              </p>
            ) : null}
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="shrink-0 text-destructive hover:text-destructive"
          onClick={() => void onDelete()}
        >
          Delete persona
        </Button>
      </div>

      <div className="space-y-1.5">
        <SectionLabel>Persona</SectionLabel>
        <div className="space-y-2.5">
          <div className="space-y-1">
            <Label htmlFor="persona-name" className="text-xs">
              Name
            </Label>
            <Input
              id="persona-name"
              value={name}
              autoFocus={autoEditName}
              placeholder="Persona name"
              onChange={(event) => setName(event.target.value)}
              onBlur={() => void commit("name", name, persona.name, setName)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="persona-role" className="text-xs">
              Role
            </Label>
            <Input
              id="persona-role"
              value={role}
              placeholder="Role"
              onChange={(event) => setRole(event.target.value)}
              onBlur={() => void commit("role", role, persona.role, setRole)}
            />
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <SectionLabel>Use cases &amp; context</SectionLabel>
        <TextareaAutosize
          aria-label="Use cases and context"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          onBlur={() =>
            void commit("notes", notes, persona.notes ?? "", setNotes)
          }
          minRows={3}
          maxRows={10}
          placeholder="Who they are and how they show up…"
          className="resize-none text-sm leading-relaxed"
        />
      </div>
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
    config: { sessionsPerTarget: number; maxTurns: number };
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
  const [sessionsPerTarget, setSessionsPerHost] = useState(2);
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
      <button
        type="button"
        data-testid="persona-add-goal"
        className="rounded-sm text-xs font-medium text-primary outline-none hover:text-primary/80 focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setOpen(true)}
      >
        + Add goal
      </button>
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
          value={sessionsPerTarget}
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
              bareAutoGradeBlurb="Grade every session automatically against this goal. Uses credits. You can also judge any session on demand from its detail view."
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
            !Number.isInteger(sessionsPerTarget) ||
            sessionsPerTarget < 1 ||
            sessionsPerTarget > 5 ||
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
              config: { sessionsPerTarget, maxTurns },
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
          Create goal
        </Button>
      </div>
    </div>
  );
}
