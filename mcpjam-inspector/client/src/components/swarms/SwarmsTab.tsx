/**
 * Project-scoped Swarms surface (redesign): Persona → Journey → Run.
 *
 * Replaces the old host-anchored `ChatboxesTab product="swarm"`. Personas and
 * journeys live at the project level; a journey targets one-or-more hosts and,
 * when run, fans out one single-host session per (host × sessionsPerHost).
 *
 * Top-level views (ViewModeSelector):
 *   - Journeys — persona detail, journey cards, run matrix / live stream
 *   - Sessions — flat chatSessions browser for the selected persona
 *     (`listSessionsByPersona` + shared ShareUsageThreadList/Detail)
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
import { useQuery, useMutation, usePaginatedQuery } from "convex/react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Info,
  Loader2,
  Plus,
  Users,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { Textarea } from "@mcpjam/design-system/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { InlineEditableText } from "@/components/ui/inline-editable-text";
import { TextareaAutosize } from "@/components/ui/textarea-autosize";
import { PersonaPixelAvatar } from "@/components/swarms/persona-pixel-avatar";
import { PersonaAvatarLookPicker } from "@/components/swarms/persona-avatar-look-picker";
import { JourneyNetworkBackdrop } from "@/components/swarms/journey-network-backdrop";
import {
  launchJourneyRun,
  LaunchJourneyRunError,
  SWARM_QUERIES,
  DEFAULT_PAGE_SIZE,
  swarmAttemptChatSessionId,
  type GoalScoreRollup,
  type JourneyRun,
  type JourneySessionRow,
  type PersonaTrackRecord,
  type JourneyRollup,
  type SessionGoalScore,
} from "@/lib/swarm-api";
import { formatScore } from "@/components/shared/session-quality/judge-presentation";
import { ShareUsageThreadDetail } from "@/components/connection/share-usage/ShareUsageThreadDetail";
import {
  buildEvalsPath,
  buildSwarmSessionPath,
  navigateApp,
  parseSwarmSessionParams,
} from "@/lib/app-navigation";
import { getShareableAppOrigin } from "@/lib/chatbox-session";
import { resolveHostLogoByDisplayName } from "@/lib/chatbox-client-style";
import { ConvertSwarmSessionDialog } from "@/components/swarms/convert-swarm-session-dialog";
import { SwarmsSessionsPanel } from "@/components/swarms/SwarmsSessionsPanel";
import {
  SwarmLiveStreamPane,
  SwarmSessionsMatrix,
  type SwarmMatrixSelection,
} from "@/components/swarms/journey-run-results";
import {
  liveSessionTrace,
  useJourneyRunStream,
} from "@/components/swarms/use-journey-run-stream";
import { ViewModeSelector } from "@/components/shared/view-mode-selector";
import { ServerGroupPicker } from "@/components/hosts/ServerGroupPicker";
import { useProjectServerAttachments } from "@/hooks/useViews";
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

// Judge-verdict guard: the backend denormalizes a WIDE `goalScore` subset;
// validate the status enum + score before rendering so a malformed record
// degrades to "no badge".
const GOAL_SCORE_STATUSES = ["running", "completed", "failed"] as const;
type GoalScoreStatus = (typeof GOAL_SCORE_STATUSES)[number];

export function toSessionGoalScore(raw: JourneySessionRow["goalScore"]):
  | (SessionGoalScore & { status: GoalScoreStatus })
  | undefined {
  if (!raw) return undefined;
  if (!(GOAL_SCORE_STATUSES as readonly string[]).includes(raw.status ?? "")) {
    return undefined;
  }
  const status = raw.status as GoalScoreStatus;
  // A completed verdict must carry BOTH a finite score and a boolean passed —
  // a malformed `passed` must not silently render as "below threshold".
  if (
    status === "completed" &&
    (!Number.isFinite(raw.score) || typeof raw.passed !== "boolean")
  ) {
    return undefined;
  }
  return { ...raw, status };
}

/**
 * Per-session judge score badge, rendered next to the readiness badge.
 * completed → "82% · meets goal"; running → "judging…"; failed → "judge
 * unavailable" (never silently hidden — the viewer offers Retry); absent →
 * nothing.
 */
export function SessionGoalScoreBadge({
  goalScore,
}: {
  goalScore: JourneySessionRow["goalScore"];
}) {
  const gs = toSessionGoalScore(goalScore);
  if (!gs) return null;
  if (gs.status === "running") {
    return (
      <span className="rounded-sm bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
        judging…
      </span>
    );
  }
  if (gs.status === "failed") {
    return (
      <span
        className="rounded-sm bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground"
        title={gs.error ?? "Judge run failed — open the session to retry"}
      >
        judge unavailable
      </span>
    );
  }
  return (
    <span
      className={`rounded-sm px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${
        gs.passed ? "bg-success/50 text-foreground" : "bg-warning/50 text-foreground"
      }`}
      title={gs.reason ?? undefined}
    >
      {formatScore(gs.score ?? NaN)} · {gs.passed ? "meets goal" : "below threshold"}
    </span>
  );
}

/** `· goal 78% avg (4 judged)` — used on journey run cards. */
export function goalScoreAvgLabel(rollup: GoalScoreRollup | undefined): string | null {
  if (!rollup || rollup.gradedCount === 0 || rollup.avgScore === null) {
    return null;
  }
  return `goal ${formatScore(rollup.avgScore)} avg (${rollup.gradedCount} judged)`;
}

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
  config: { sessionsPerHost: number; maxTurns: number };
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
    projectId ? ({ projectId } as any) : "skip",
  ) as string[] | undefined;

  useEffect(() => {
    onChange(ids ?? []);
  }, [ids, onChange]);

  return null;
}

export function SwarmsTab({
  projectId,
  isAuthenticated,
}: SwarmsTabProps) {
  // Don't subscribe to project-scoped Convex reads until auth is ready — a
  // signed-out/loading mount with a persisted project would otherwise surface
  // authorization errors instead of holding the screen.
  const effectiveProjectId = isAuthenticated ? projectId : null;
  const personas = usePersonas(effectiveProjectId);
  const hosts = useProjectHosts(effectiveProjectId);
  const [runningPersonaIds, setRunningPersonaIds] = useState<string[]>([]);
  const runningSet = useMemo(
    () => new Set(runningPersonaIds),
    [runningPersonaIds],
  );
  const onRunningPersonasChange = useCallback((ids: string[]) => {
    setRunningPersonaIds(ids);
  }, []);
  // Restore a copied session deep-link (`/swarms?persona=&run=&host=&session=`).
  // Parse ONCE on mount so later user navigation isn't clobbered by the URL.
  const deepLink = useMemo(
    () => parseSwarmSessionParams(window.location.search),
    [],
  );
  type SwarmViewMode = "journeys" | "sessions";
  const SWARM_VIEW_OPTIONS = [
    { value: "journeys" as const, label: "Journeys" },
    { value: "sessions" as const, label: "Sessions" },
  ];
  // Session deep-links open the flat Sessions browser; run-only links stay on
  // Journeys so the matrix / live stream can restore.
  const [viewMode, setViewMode] = useState<SwarmViewMode>(() =>
    deepLink.threadId ? "sessions" : "journeys",
  );
  const [selectedPersonaId, setSelectedPersonaId] = useState<string | null>(
    () => deepLink.personaRefId ?? null,
  );
  const journeys = useJourneys(selectedPersonaId);
  // Lifted for the agent snapshot (one subscription).

  const createPersona = useMutation("personas:createPersona" as any);
  const updatePersona = useMutation("personas:updatePersona" as any);
  const deletePersona = useMutation("personas:deletePersona" as any);
  const createJourney = useMutation("journeys:createJourney" as any);

  const savePersonaField = useCallback(
    async (
      personaRefId: string,
      patch: {
        name?: string;
        role?: string;
        notes?: string;
        avatarShape?: number;
        avatarPalette?: number;
      },
    ) => {
      try {
        await updatePersona({ personaRefId, ...patch } as any);
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to update persona",
        );
        throw error;
      }
    },
    [updatePersona],
  );

  const selectedPersona = useMemo(
    () => personas?.find((p) => p._id === selectedPersonaId) ?? null,
    [personas, selectedPersonaId]
  );
  // Gate on the VALIDATED persona, not the raw URL-derived id: a copied
  // /swarms?persona=... deep link opened while signed out (or with a stale id)
  // must not subscribe getPersonaTrackRecord before the allowed persona list
  // has loaded and matched — that surfaces backend authorization errors.
  const trackRecord = usePersonaTrackRecord(
    selectedPersona ? selectedPersonaId : null,
  );

  // New-journey form, lifted so `ui_open_journey_form` can open it (the
  // prefill-over-commit posture — a journey targets hosts + sets fan-out
  // config, so the human finishes and submits it).
  const [journeyFormOpen, setJourneyFormOpen] = useState(false);
  const [journeyGoalSeed, setJourneyGoalSeed] = useState("");

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
        "Swarms is locked here — sign in and select a project before using the swarm tools.",
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
      journeyId: string,
    ): Promise<
      | { status: "launched"; runId?: string }
      | { status: "already_launching" }
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
    [projectId],
  );

  // Exact (case-insensitive) resolution against the loaded lists — unknown or
  // ambiguous → invalid_request, never a fuzzy guess.
  const resolvePersona = (raw: unknown): Persona => {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw createInspectorCommandClientError(
        "invalid_request",
        "Missing required 'persona' string (a persona name or id).",
      );
    }
    const wanted = raw.trim();
    const wantedLower = wanted.toLowerCase();
    const matches = (personas ?? []).filter(
      (p) => p._id === wanted || p.name.toLowerCase() === wantedLower,
    );
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) {
      throw createInspectorCommandClientError(
        "invalid_request",
        `No persona matches "${wanted}". Use a persona name or id from this screen (list them with ui_snapshot_app).`,
      );
    }
    throw createInspectorCommandClientError(
      "invalid_request",
      `${matches.length} personas match "${wanted}" — pass the persona id instead (ids are in ui_snapshot_app).`,
    );
  };

  const resolveJourney = (raw: unknown): Journey => {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw createInspectorCommandClientError(
        "invalid_request",
        "Missing required 'journey' string (a goal or journey id).",
      );
    }
    if (!selectedPersona) {
      throw createInspectorCommandClientError(
        "invalid_request",
        "Select a persona first — journeys are listed per persona (see ui_snapshot_app).",
      );
    }
    const wanted = raw.trim();
    const wantedLower = wanted.toLowerCase();
    const matches = (journeys ?? []).filter(
      (j) =>
        j._id === wanted ||
        j.goal.toLowerCase() === wantedLower ||
        (j.name ?? "").toLowerCase() === wantedLower,
    );
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) {
      throw createInspectorCommandClientError(
        "invalid_request",
        `No journey matches "${wanted}" for persona "${selectedPersona.name}". Use a journey goal or id from this screen; if the journey belongs to another persona, select that persona first.`,
      );
    }
    throw createInspectorCommandClientError(
      "invalid_request",
      `${matches.length} journeys match "${wanted}" — pass the journey id instead (ids are in ui_snapshot_app).`,
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
            "No project is selected.",
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
            "Missing required 'name' string.",
          );
        }
        if (!role) {
          throw createInspectorCommandClientError(
            "invalid_request",
            "Missing required 'role' string.",
          );
        }
        if (payload?.notes !== undefined && typeof payload.notes !== "string") {
          throw createInspectorCommandClientError(
            "invalid_request",
            "'notes' must be a string when provided.",
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
            "Select or name a persona first — a journey belongs to a persona.",
          );
        }
        if (payload?.goal !== undefined && typeof payload.goal !== "string") {
          throw createInspectorCommandClientError(
            "invalid_request",
            "'goal' must be a string when provided.",
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
          note: "The user picks a server group, target hosts, and fan-out config and submits — no journey is created yet.",
        };
      },
      launchSwarmRun: async (command) => {
        requireAgentOperable();
        const pid = projectId;
        if (!pid) {
          throw createInspectorCommandClientError(
            "unsupported_in_mode",
            "No project is selected.",
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
              "This journey is already launching — wait for it to start.",
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
                `Cannot launch this journey run: ${e.message} Launching spends the organization's swarm quota, which is exhausted — do not retry until it resets or billing is updated.`,
              );
            }
            throw createInspectorCommandClientError(
              "execution_failed",
              `Could not launch the journey run: ${e.message}`,
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
        {/* Personas */}
        <aside className="flex w-72 shrink-0 flex-col border-r">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <h2 className="text-sm font-semibold">Personas</h2>
            <NewPersonaDialog
              onCreate={async (draft) => {
                const row = await createPersona({ projectId, ...draft } as any);
                setSelectedPersonaId(row._id);
              }}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {personas === undefined ? (
              <div className="p-4 text-sm text-muted-foreground">Loading…</div>
            ) : personas.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">
                No personas yet. Create one to get started.
              </div>
            ) : (
              personas.map((p) => {
                const selected = p._id === selectedPersonaId;
                return (
                  <button
                    key={p._id}
                    type="button"
                    onClick={() => setSelectedPersonaId(p._id)}
                    className={cn(
                      "flex w-full items-center gap-3 border-b px-4 py-3 text-left hover:bg-muted/50",
                      selected && "bg-muted",
                    )}
                  >
                    <PersonaPixelAvatar
                      seed={p._id}
                      shapeIndex={p.avatarShape}
                      paletteIndex={p.avatarPalette}
                      size="md"
                      active={selected}
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
                );
              })
            )}
          </div>
        </aside>

        {viewMode === "sessions" ? (
          <main className="min-w-0 flex-1 overflow-hidden">
            <SwarmsSessionsPanel
              projectId={projectId}
              personaRefId={selectedPersona?._id ?? null}
              personaName={selectedPersona?.name}
              onClearPersonaFilter={() => setSelectedPersonaId(null)}
              initialThreadId={deepLink.threadId}
            />
          </main>
        ) : (
          /* Journeys for the selected persona */
          <main className="min-w-0 flex-1 overflow-y-auto">
            {!selectedPersona ? (
              <JourneyNetworkBackdrop />
            ) : (
              <div className="mx-auto max-w-3xl px-8 py-6">
                <PersonaDetailHeader
                  persona={selectedPersona}
                  running={runningSet.has(selectedPersona._id)}
                  onSave={(patch) => savePersonaField(selectedPersona._id, patch)}
                  onDelete={async () => {
                    if (
                      !window.confirm(
                        `Delete persona "${selectedPersona.name}"? Its journeys are hidden but historical runs are kept.`,
                      )
                    ) {
                      return;
                    }
                    await deletePersona({
                      personaRefId: selectedPersona._id,
                    } as any);
                    setSelectedPersonaId(null);
                  }}
                />

                <div
                  className={cn(
                    "mb-3",
                    journeyFormOpen
                      ? "space-y-2"
                      : "flex items-center justify-between",
                  )}
                >
                  <h3 className="text-sm font-semibold">Journeys</h3>
                  <NewJourneyButton
                    projectId={projectId}
                    hosts={hosts ?? []}
                    open={journeyFormOpen}
                    onOpenChange={(o) => {
                      setJourneyFormOpen(o);
                      // Drop the agent prefill on close so a later manual open
                      // starts blank.
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
                  <div className="text-sm text-muted-foreground">Loading…</div>
                ) : journeys.length === 0 ? (
                  <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                    No journeys yet. A journey is a goal this persona pursues
                    across one or more hosts.
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {journeys.map((j) => (
                      <JourneyCard
                        key={j._id}
                        journey={j}
                        onLaunch={launchJourney}
                        hosts={hosts ?? []}
                        isAuthenticated={isAuthenticated}
                        projectId={projectId}
                        initialRunId={deepLink.runId}
                        initialThreadId={deepLink.threadId}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </main>
        )}
      </div>
    </div>
  );
}

// ── run status treatment ─────────────────────────────────────────────────────
function runStatusChipClass(status: string): string {
  switch (status) {
    case "completed":
      return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
    case "partial":
    case "rate_limited":
      return "bg-muted text-muted-foreground";
    case "failed":
      return "bg-red-500/10 text-red-700 dark:text-red-400";
    case "stale":
      return "bg-muted text-muted-foreground";
    default:
      return "bg-muted text-foreground"; // running
  }
}

function formatJourneyRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function runSummaryLine(r: JourneyRun): string {
  const parts = [
    `${r.summary.succeeded}/${r.summary.total} ok`,
    r.summary.failed > 0 ? `${r.summary.failed} failed` : null,
    r.summary.rateLimited > 0 ? `${r.summary.rateLimited} rate-limited` : null,
    goalScoreAvgLabel(r.goalScoreSummary),
  ].filter(Boolean);
  return parts.join(" · ");
}

// ── journey card + runs ──────────────────────────────────────────────────────
function JourneyCard({
  journey,
  hosts,
  isAuthenticated,
  projectId,
  initialRunId,
  initialThreadId,
  onLaunch,
}: {
  journey: Journey;
  hosts: HostItem[];
  isAuthenticated: boolean;
  projectId: string;
  /** Shared launch coordinator — see SwarmsTab.launchJourney. */
  onLaunch: (
    journeyId: string,
  ) => Promise<
    { status: "launched"; runId?: string } | { status: "already_launching" }
  >;
  /** Deep-link run to auto-open (only the card that owns it reacts). */
  initialRunId?: string;
  /** Deep-link session to auto-select inside the opened run. */
  initialThreadId?: string;
}) {
  const { serverAttachments } = useProjectServerAttachments({
    isAuthenticated,
    projectId,
  });
  const serverGroupName = journey.serverAttachmentId
    ? (serverAttachments.find((a) => a._id === journey.serverAttachmentId)
        ?.name ?? null)
    : null;
  // Real Convex pagination (numItems + cursor) over the journey's runs.
  const {
    results: runs,
    status: runsStatus,
    loadMore,
  } = usePaginatedQuery(
    SWARM_QUERIES.listJourneyRuns as any,
    { journeyRefId: journey._id } as any,
    { initialNumItems: DEFAULT_PAGE_SIZE }
  );
  const rollup = useQuery(
    SWARM_QUERIES.journeyRollup as any,
    { journeyRefId: journey._id } as any
  ) as JourneyRollup | undefined;

  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  // Deep-link restore: expand this journey and open the linked run so
  // RunSessionsView mounts. Runs once — later user toggling isn't overridden.
  const appliedInitialRunRef = useRef(false);
  useEffect(() => {
    if (appliedInitialRunRef.current || !initialRunId) return;
    if ((runs as JourneyRun[]).some((r) => r._id === initialRunId)) {
      appliedInitialRunRef.current = true;
      setExpanded(true);
      setOpenRunId(initialRunId);
    }
  }, [initialRunId, runs]);

  const hostName = (id: string) =>
    hosts.find((h) => h.hostId === id)?.name ?? id.slice(0, 8);

  const journeyHostNames = useMemo(
    () => journey.hostIds.map(hostName),
    // hostName closes over `hosts`; recompute when either changes.
    [journey.hostIds, hosts],
  );
  const firstHostName = journeyHostNames[0] ?? null;
  const extraHosts = Math.max(0, journeyHostNames.length - 1);
  const typedRuns = runs as JourneyRun[];
  const latestRun = typedRuns[0] ?? null;
  const runCount = rollup?.runCount ?? typedRuns.length;
  const hasRuns = runCount > 0 || typedRuns.length > 0;
  const configHint = `${journey.config.sessionsPerHost}/host · ${journey.config.maxTurns} turns`;

  const onRun = async () => {
    if (launching) return;
    setLaunchError(null);
    setLaunching(true);
    try {
      // Shared coordinator: same launchKey store as the agent path, so a
      // concurrent agent launch of this journey dedupes to one paid run.
      const result = await onLaunch(journey._id);
      if (result.status === "already_launching") {
        return; // another launch of this journey is already in flight
      }
      toast.success("Journey run started");
    } catch (e) {
      // The coordinator retains the key on ANY failure and reuses it on retry,
      // so the backend dedupes rather than double-spending.
      setLaunchError(e instanceof Error ? e.message : "Failed to start run");
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div className="rounded-lg border border-border/60 px-3 py-2.5">
      <div className="flex items-start gap-1.5">
        <button
          type="button"
          className={cn(
            "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors",
            "hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            !hasRuns && "cursor-default opacity-40 hover:bg-transparent",
          )}
          aria-expanded={expanded}
          aria-label={expanded ? "Hide runs" : "Show runs"}
          disabled={!hasRuns}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <button
              type="button"
              className="min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
              disabled={!hasRuns}
              onClick={() => hasRuns && setExpanded((v) => !v)}
            >
              <p className="truncate text-sm font-medium">{journey.goal}</p>
            </button>
            <Button
              type="button"
              size="sm"
              className="h-7 shrink-0 px-2.5 text-xs"
              disabled={launching}
              onClick={onRun}
            >
              {launching ? "Starting…" : "Run"}
            </Button>
          </div>

          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
            {firstHostName ? (
              <span className="inline-flex min-w-0 max-w-[160px] items-center gap-1">
                <JourneyHostLogoMark label={firstHostName} />
                <span className="truncate font-medium text-foreground/80">
                  {firstHostName}
                </span>
                {extraHosts > 0 ? (
                  <span className="shrink-0 text-[10px]">+{extraHosts}</span>
                ) : null}
              </span>
            ) : (
              <span>No clients</span>
            )}
            {serverGroupName ? (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{serverGroupName}</span>
              </>
            ) : null}
            <span aria-hidden>·</span>
            <span>
              {runCount} run{runCount === 1 ? "" : "s"}
            </span>
            {latestRun ? (
              <>
                <span aria-hidden>·</span>
                <span
                  className={cn(
                    "rounded-full px-1.5 py-px text-[10px] font-medium capitalize",
                    runStatusChipClass(latestRun.status),
                  )}
                >
                  {latestRun.status.replace(/_/g, " ")}
                </span>
              </>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Journey config"
                  className="rounded-full p-0.5 text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Info className="size-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[220px]">
                <p className="text-xs leading-snug">{configHint}</p>
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>

      {launchError && (
        <p className="mt-2 ml-7 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-600 dark:text-red-400">
          {launchError}
        </p>
      )}

      {expanded && (
        <div className="mt-2 ml-7 space-y-0.5 border-t border-border/40 pt-2">
          {typedRuns.length === 0 ? (
            <p className="px-1 py-1.5 text-[11px] text-muted-foreground">
              No runs yet.
            </p>
          ) : (
            typedRuns.map((r) => {
              const isOpen = openRunId === r._id;
              return (
                <div key={r._id}>
                  <button
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-xs outline-none transition-colors",
                      "hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring",
                      isOpen && "bg-muted/40",
                    )}
                    aria-expanded={isOpen}
                    aria-label={
                      isOpen
                        ? `Hide sessions for run ${r.status}`
                        : `View sessions for run ${r.status}`
                    }
                    onClick={() =>
                      setOpenRunId((cur) => (cur === r._id ? null : r._id))
                    }
                  >
                    {isOpen ? (
                      <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                    )}
                    <span className="capitalize text-foreground/90">
                      {r.status.replace(/_/g, " ")}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {runSummaryLine(r)}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {formatJourneyRelativeTime(r.createdAt)}
                    </span>
                  </button>
                  {isOpen && (
                    <RunSessionsView
                      runId={r._id}
                      personaRefId={journey.personaRefId}
                      hosts={hosts}
                      hostSummaries={r.hostSummaries}
                      runSummary={r.summary}
                      runStatus={r.status}
                      sessionsPerHost={journey.config.sessionsPerHost}
                      createdAt={r.createdAt}
                      initialThreadId={
                        initialRunId === r._id ? initialThreadId : undefined
                      }
                    />
                  )}
                </div>
              );
            })
          )}
          {runsStatus === "CanLoadMore" && (
            <button
              type="button"
              className="mt-0.5 px-1.5 text-[11px] font-medium text-primary hover:underline"
              onClick={() => loadMore(DEFAULT_PAGE_SIZE)}
            >
              Load more runs
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── sessions × hosts matrix + live stream (per run) ──────────────────────────
function RunSessionsView({
  runId,
  personaRefId,
  hosts,
  hostSummaries,
  runSummary,
  runStatus,
  sessionsPerHost,
  createdAt,
  initialThreadId,
}: {
  runId: string;
  /** Owning persona — encoded into copied session links for deep-link restore. */
  personaRefId: string;
  hosts: HostItem[];
  hostSummaries: JourneyRun["hostSummaries"];
  runSummary: JourneyRun["summary"];
  runStatus: JourneyRun["status"];
  sessionsPerHost: number;
  createdAt: number;
  /** Deep-link session (`id`) to auto-select once it's on a loaded page. */
  initialThreadId?: string;
}) {
  const {
    results: sessions,
    status,
    loadMore,
  } = usePaginatedQuery(
    SWARM_QUERIES.listSessionsByJourneyRun as any,
    { journeyRunId: runId } as any,
    { initialNumItems: Math.max(DEFAULT_PAGE_SIZE, sessionsPerHost * 4) },
  );

  const streamEnabled = runStatus === "running";
  const stream = useJourneyRunStream(runId, streamEnabled);

  const [selection, setSelection] = useState<SwarmMatrixSelection | null>(null);
  const [detailSession, setDetailSession] = useState<JourneySessionRow | null>(
    null,
  );
  const [sessionToPromote, setSessionToPromote] =
    useState<JourneySessionRow | null>(null);

  const hostName = (id: string) =>
    hosts.find((h) => h.hostId === id)?.name ?? id.slice(0, 8);

  const rows = sessions as JourneySessionRow[];
  const hostIds = useMemo(() => {
    const fromSummary = hostSummaries.map((h) => h.hostId);
    if (fromSummary.length > 0) return fromSummary;
    const seen = new Set<string>();
    for (const s of rows) seen.add(s.hostId);
    return Array.from(seen);
  }, [hostSummaries, rows]);

  const convexByChatId = useMemo(() => {
    const map = new Map<string, JourneySessionRow>();
    for (const s of rows) map.set(s.chatSessionId, s);
    return map;
  }, [rows]);

  const selectedConvex = selection
    ? (convexByChatId.get(selection.chatSessionId) ?? null)
    : null;

  const fallbackTrace = useMemo(
    () =>
      selection
        ? liveSessionTrace(stream.sessions[selection.chatSessionId])
        : null,
    [selection, stream.sessions],
  );

  // Deep-link restore: select the matrix cell for the linked Convex session.
  const appliedInitialThreadRef = useRef(false);
  useEffect(() => {
    if (appliedInitialThreadRef.current || !initialThreadId) return;
    const match = rows.find((s) => s.id === initialThreadId);
    if (!match) return;
    appliedInitialThreadRef.current = true;
    const sessionIndex = Number(
      match.chatSessionId.split("_").pop() ?? "0",
    );
    setSelection({
      hostId: match.hostId,
      sessionIndex: Number.isFinite(sessionIndex) ? sessionIndex : 0,
      chatSessionId: match.chatSessionId,
    });
    setDetailSession(match);
  }, [initialThreadId, rows]);

  // Auto-select the first running cell when a live stream starts.
  useEffect(() => {
    if (selection || !streamEnabled) return;
    const runningEntry = Object.entries(stream.cellStatus).find(
      ([, status]) => status === "running",
    );
    if (!runningEntry) return;
    const [key] = runningEntry;
    const [hostId, idxStr] = key.split(":");
    if (!hostId || idxStr == null) return;
    const sessionIndex = Number(idxStr);
    if (!Number.isFinite(sessionIndex)) return;
    setSelection({
      hostId,
      sessionIndex,
      chatSessionId: swarmAttemptChatSessionId(runId, hostId, sessionIndex),
    });
  }, [selection, streamEnabled, stream.cellStatus, runId]);

  return (
    <div className="mt-2 space-y-3 rounded-lg border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[12px] font-semibold capitalize text-foreground/90">
            {String(runStatus).replace(/_/g, " ")}
            <span className="ml-2 font-normal text-muted-foreground">
              {runSummary.succeeded}/{runSummary.total} ok
              {runSummary.failed > 0 ? ` · ${runSummary.failed} failed` : ""}
            </span>
          </p>
          <p className="text-[10px] text-muted-foreground">
            {formatJourneyRelativeTime(createdAt)}
            {stream.connected ? " · live" : null}
            {stream.error ? ` · stream error: ${stream.error}` : null}
          </p>
        </div>
        {status === "CanLoadMore" ? (
          <button
            type="button"
            className="text-[11px] font-medium text-primary hover:underline"
            onClick={() => loadMore(DEFAULT_PAGE_SIZE)}
          >
            Load more sessions
          </button>
        ) : null}
      </div>

      <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <SwarmSessionsMatrix
          runId={runId}
          hostIds={hostIds}
          hostName={hostName}
          sessionsPerHost={sessionsPerHost}
          sessions={rows}
          hostSummaries={hostSummaries}
          stream={stream}
          runStatus={String(runStatus)}
          selection={selection}
          onSelect={(sel) => {
            setSelection(sel);
            setDetailSession(null);
          }}
        />
        <SwarmLiveStreamPane
          selection={selection}
          stream={stream}
          convexSession={selectedConvex}
          fallbackTrace={fallbackTrace}
          runStatus={String(runStatus)}
          onOpenCompleted={(session) => setDetailSession(session)}
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
            }),
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
  onSave,
  onDelete,
}: {
  persona: Persona;
  running: boolean;
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
          <InlineEditableText
            value={persona.name}
            onSave={(name) => onSave({ name })}
            className="block w-full text-lg font-semibold tracking-tight sm:text-xl"
            truncate={false}
          />
          <InlineEditableText
            value={persona.role}
            onSave={(role) => onSave({ role })}
            className="mt-0.5 block w-full text-sm text-muted-foreground"
            truncate={false}
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
              "focus-visible:border-0 focus-visible:ring-0",
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

// ── create persona dialog (design-system; replaces the floating raw form) ────
function NewPersonaDialog({
  onCreate,
}: {
  onCreate: (draft: {
    name: string;
    role: string;
    notes?: string;
  }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      setName("");
      setRole("");
      setNotes("");
      setSaving(false);
    }
  }, [open]);

  const handleCreate = async () => {
    if (!name.trim() || !role.trim()) {
      toast.error("Name and role are required");
      return;
    }
    setSaving(true);
    try {
      await onCreate({
        name: name.trim(),
        role: role.trim(),
        notes: notes.trim() || undefined,
      });
      toast.success("Persona created");
      setOpen(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to create persona",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
      >
        <Plus className="mr-1 size-3" />
        New
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New persona</DialogTitle>
            <DialogDescription>
              A synthetic user who pursues journeys across your clients.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-1">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="swarm-persona-name">Name</Label>
              <Input
                id="swarm-persona-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Test User"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleCreate();
                  }
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="swarm-persona-role">Role</Label>
              <Input
                id="swarm-persona-role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="SWE evaluating the product"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleCreate();
                  }
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="swarm-persona-notes">Notes / personality</Label>
              <Textarea
                id="swarm-persona-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Background, tone, what they care about…"
                rows={4}
                className="leading-relaxed"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={saving || !name.trim() || !role.trim()}
              onClick={() => void handleCreate()}
            >
              {saving ? (
                <Loader2 className="mr-1 size-3 animate-spin" />
              ) : null}
              Create persona
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function NewJourneyButton({
  projectId,
  hosts,
  onCreate,
  open,
  onOpenChange,
  goalSeed,
}: {
  projectId: string;
  hosts: HostItem[];
  onCreate: (draft: {
    goal: string;
    hostIds: string[];
    serverAttachmentId: string;
    config: { sessionsPerHost: number; maxTurns: number };
  }) => Promise<void>;
  // Controlled by SwarmsTab so `ui_open_journey_form` can open + prefill it.
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Goal to seed each time the form opens ("" for a manual open). */
  goalSeed: string;
}) {
  const [goal, setGoal] = useState("");
  const [hostIds, setHostIds] = useState<string[]>([]);
  const [serverAttachmentId, setServerAttachmentId] = useState<string | null>(
    null,
  );
  const [sessionsPerHost, setSessionsPerHost] = useState(2);
  const [maxTurns, setMaxTurns] = useState(6);
  const [clientsPickerOpen, setClientsPickerOpen] = useState(false);
  // Seed the goal from the agent prefill (or reset to "") whenever the form
  // transitions open. Manual "+ New journey" opens pass goalSeed="".
  useEffect(() => {
    if (open) setGoal(goalSeed);
  }, [open, goalSeed]);
  const setOpen = onOpenChange;
  // A journey may target ANY project host, including chatbox/suite-owned ones
  // (the backend validates only project ownership). But surface the Swarms'
  // own clients first and badge the "shared" ones so it's clear which hosts
  // are managed elsewhere. (Deliberately NOT filtered — that would break
  // cross-product journey targeting.)
  const isSwarmClient = (h: HostItem) =>
    !h.ownerScope || h.ownerScope.type === "journeys";
  const sortedHosts = useMemo(
    () =>
      [...hosts].sort((a, b) => {
        const rank = (h: HostItem) => (isSwarmClient(h) ? 0 : 1);
        return rank(a) - rank(b) || a.name.localeCompare(b.name);
      }),
    [hosts],
  );
  const selectedHosts = useMemo(
    () => sortedHosts.filter((h) => hostIds.includes(h.hostId)),
    [sortedHosts, hostIds],
  );
  const clientsTriggerLabel =
    selectedHosts.length === 0
      ? "No clients · pick one"
      : (selectedHosts[0]?.name ?? "Clients");
  const clientsExtra =
    selectedHosts.length > 1 ? selectedHosts.length - 1 : 0;

  if (!open) {
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Plus className="mr-1 size-3" />
        New journey
      </Button>
    );
  }
  const toggleHost = (id: string) =>
    setHostIds((prev) =>
      prev.includes(id) ? prev.filter((h) => h !== id) : [...prev, id]
    );
  return (
    <div
      className={cn(
        "w-full rounded-xl border border-border/50 bg-card/50 p-3 shadow-sm",
        "ring-1 ring-black/[0.03] dark:ring-white/[0.06]",
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

      {/* Compact picker bar — same pill language as SuiteOverviewClientBar. */}
      <div className="mb-2.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2">
        <ServerGroupPicker
          projectId={projectId}
          value={serverAttachmentId}
          onChange={(id) => setServerAttachmentId(id)}
          onClearSelection={() => setServerAttachmentId(null)}
          emptyTriggerLabel="No server group · pick one"
          infoText="A named set of MCP servers shared across every client this journey targets — same pattern as eval suites."
        />

        <Popover open={clientsPickerOpen} onOpenChange={setClientsPickerOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                "flex h-8 max-w-[260px] shrink-0 items-center gap-1 rounded-full border px-2 text-foreground",
                "outline-none transition-colors",
                hostIds.length === 0
                  ? "border-dashed border-border/60 bg-muted/30 hover:bg-muted/45"
                  : "border-border/60 bg-muted/40 hover:bg-muted/60",
              )}
              aria-label="Attached clients"
            >
              {selectedHosts[0] ? (
                <JourneyHostLogoMark label={selectedHosts[0].name} />
              ) : (
                <Users className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate text-xs font-medium">
                {clientsTriggerLabel}
              </span>
              {clientsExtra > 0 ? (
                <span className="text-[10px] text-muted-foreground">
                  +{clientsExtra}
                </span>
              ) : null}
              <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            className="w-64 p-1"
            align="start"
            sideOffset={4}
            // Multi-select: don't dismiss when focus moves between rows
            // (Radix otherwise treats the click as "outside" the trigger).
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            <div className="space-y-0.5" role="group" aria-label="Clients">
              <div className="flex items-center justify-between gap-2 px-2 pb-1 pt-0.5">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Clients
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label="What is a client?"
                      className="rounded-full p-0.5 text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Info className="size-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-[240px]">
                    <p className="text-xs leading-snug">
                      Pick one or more. Each selected client fans out into its
                      own sessions for this journey.
                    </p>
                  </TooltipContent>
                </Tooltip>
              </div>
              {hosts.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  No clients in this project.
                </p>
              ) : (
                sortedHosts.map((h) => {
                  const selected = hostIds.includes(h.hostId);
                  const shared = !isSwarmClient(h);
                  const meta = [
                    h.modelId || null,
                    h.hasComputer ? "computer" : null,
                  ].filter(Boolean);
                  return (
                    <button
                      key={h.hostId}
                      type="button"
                      role="checkbox"
                      aria-checked={selected}
                      // Prevent focus steal from closing the multi-select popover
                      // before the toggle applies (same pattern as evals).
                      onPointerDown={(e) => e.preventDefault()}
                      onClick={() => toggleHost(h.hostId)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded py-1.5 pl-2 pr-2 text-left text-sm",
                        "hover:bg-accent hover:text-accent-foreground",
                        selected && "bg-accent/50",
                      )}
                    >
                      <Check
                        className={cn(
                          "size-3.5 shrink-0",
                          selected ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <JourneyHostLogoMark label={h.name} />
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-medium">{h.name}</span>
                        {shared ? (
                          <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                            shared
                          </span>
                        ) : null}
                        {meta.length > 0 ? (
                          <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                            {meta.join(" · ")}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </PopoverContent>
        </Popover>

        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
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
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={
            !goal.trim() ||
            !serverAttachmentId ||
            hostIds.length === 0 ||
            !Number.isInteger(sessionsPerHost) ||
            sessionsPerHost < 1 ||
            sessionsPerHost > 5 ||
            !Number.isInteger(maxTurns) ||
            maxTurns < 1 ||
            maxTurns > 20
          }
          onClick={async () => {
            if (!serverAttachmentId) return;
            await onCreate({
              goal,
              hostIds,
              serverAttachmentId,
              config: { sessionsPerHost, maxTurns },
            });
            setOpen(false);
            setGoal("");
            setHostIds([]);
            setServerAttachmentId(null);
          }}
        >
          Create journey
        </Button>
      </div>
    </div>
  );
}

function JourneyHostLogoMark({ label }: { label: string }) {
  const logoSrc = resolveHostLogoByDisplayName(label);
  if (logoSrc) {
    return (
      <img
        src={logoSrc}
        alt=""
        className="size-3.5 shrink-0 object-contain"
      />
    );
  }
  return (
    <span aria-hidden className="size-3.5 shrink-0 rounded-full bg-muted" />
  );
}
