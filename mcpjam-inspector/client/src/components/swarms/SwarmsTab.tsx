/**
 * Project-scoped Swarms surface (redesign): Persona → Journey → Run.
 *
 * Replaces the old host-anchored `ChatboxesTab product="swarm"`. Personas and
 * journeys live at the project level; a journey targets one-or-more hosts and,
 * when run, fans out one single-host session per (host × sessionsPerHost).
 *
 * Consumes the project-scoped backend: personas:*, journeys:*, journeyRuns:*.
 */
import { useMemo, useRef, useState } from "react";
import { useQuery, useMutation, usePaginatedQuery } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { toast } from "@/lib/toast";
import {
  launchJourneyRun,
  LaunchJourneyRunError,
  SWARM_QUERIES,
  DEFAULT_PAGE_SIZE,
  type JourneyRun,
  type JourneySessionRow,
  type PersonaTrackRecord,
  type JourneyRollup,
} from "@/lib/swarm-api";
import {
  EMPTY_SESSION_FILTER,
  sessionMatchesFilter,
  toggleSessionFilter,
  type SessionFilterState,
} from "@/lib/session-usage-filters";
import {
  SessionReadinessBadge,
  type SessionReadiness,
} from "@/components/chatboxes/session-readiness";
import { ShareUsageThreadDetail } from "@/components/connection/share-usage/ShareUsageThreadDetail";
import { buildChatboxSessionPath, routePaths } from "@/lib/app-navigation";
import { getShareableAppOrigin } from "@/lib/chatbox-session";

type Persona = {
  _id: string;
  personaId: string;
  name: string;
  role: string;
  notes: string;
};
type Journey = {
  _id: string;
  personaRefId: string;
  name?: string;
  goal: string;
  hostIds: string[];
  config: { sessionsPerHost: number; maxTurns: number };
};
type HostItem = { hostId: string; name: string };

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

export function SwarmsTab({ projectId, isAuthenticated }: SwarmsTabProps) {
  // Don't subscribe to project-scoped Convex reads until auth is ready — a
  // signed-out/loading mount with a persisted project would otherwise surface
  // authorization errors instead of holding the screen.
  const effectiveProjectId = isAuthenticated ? projectId : null;
  const personas = usePersonas(effectiveProjectId);
  const hosts = useProjectHosts(effectiveProjectId);
  const [selectedPersonaId, setSelectedPersonaId] = useState<string | null>(null);
  const journeys = useJourneys(selectedPersonaId);

  const createPersona = useMutation("personas:createPersona" as any);
  const deletePersona = useMutation("personas:deletePersona" as any);
  const createJourney = useMutation("journeys:createJourney" as any);

  const selectedPersona = useMemo(
    () => personas?.find((p) => p._id === selectedPersonaId) ?? null,
    [personas, selectedPersonaId]
  );

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a project to manage swarms.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      {/* Personas */}
      <aside className="flex w-72 shrink-0 flex-col border-r">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Personas</h2>
          <NewPersonaButton
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
            personas.map((p) => (
              <button
                key={p._id}
                type="button"
                onClick={() => setSelectedPersonaId(p._id)}
                className={`flex w-full flex-col items-start gap-0.5 border-b px-4 py-3 text-left hover:bg-muted/50 ${
                  p._id === selectedPersonaId ? "bg-muted" : ""
                }`}
              >
                <span className="text-sm font-medium">{p.name}</span>
                <span className="text-xs text-muted-foreground">{p.role}</span>
              </button>
            ))
          )}
        </div>
      </aside>

      {/* Journeys for the selected persona */}
      <main className="min-w-0 flex-1 overflow-y-auto">
        {!selectedPersona ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Select a persona to see its journeys.
          </div>
        ) : (
          <div className="mx-auto max-w-3xl px-8 py-6">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">{selectedPersona.name}</h2>
                <p className="text-sm text-muted-foreground">
                  {selectedPersona.role}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={async () => {
                  if (
                    !window.confirm(
                      `Delete persona "${selectedPersona.name}"? Its journeys are hidden but historical runs are kept.`
                    )
                  ) {
                    return;
                  }
                  await deletePersona({
                    personaRefId: selectedPersona._id,
                  } as any);
                  setSelectedPersonaId(null);
                }}
              >
                Delete persona
              </Button>
            </div>

            <PersonaTrackRecordStrip personaRefId={selectedPersona._id} />

            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Journeys</h3>
              <NewJourneyButton
                hosts={hosts ?? []}
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
                No journeys yet. A journey is a goal this persona pursues across
                one or more hosts.
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {journeys.map((j) => (
                  <JourneyCard
                    key={j._id}
                    journey={j}
                    hosts={hosts ?? []}
                    projectId={projectId}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

// ── persona track record ─────────────────────────────────────────────────────
function PersonaTrackRecordStrip({ personaRefId }: { personaRefId: string }) {
  const record = usePersonaTrackRecord(personaRefId);
  if (!record || record.totalSessions === 0) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
      <span className="font-medium text-muted-foreground">Track record</span>
      <span className="text-emerald-600 dark:text-emerald-400">
        {record.succeeded} ok
      </span>
      {record.failed > 0 && (
        <span className="text-red-600 dark:text-red-400">
          {record.failed} failed
        </span>
      )}
      {record.rateLimited > 0 && (
        <span className="text-amber-600 dark:text-amber-400">
          {record.rateLimited} rate-limited
        </span>
      )}
      <span className="text-muted-foreground">
        across {record.totalSessions} sessions · {record.totalRuns} runs
      </span>
    </div>
  );
}

// ── run status treatment ─────────────────────────────────────────────────────
function runStatusClass(status: string): string {
  switch (status) {
    case "completed":
      return "text-emerald-600 dark:text-emerald-400";
    case "partial":
      return "text-amber-600 dark:text-amber-400";
    case "rate_limited":
      return "text-amber-600 dark:text-amber-400";
    case "failed":
      return "text-red-600 dark:text-red-400";
    case "stale":
      return "text-muted-foreground";
    default:
      return "text-foreground"; // running
  }
}

// ── journey card + runs ──────────────────────────────────────────────────────
function JourneyCard({
  journey,
  hosts,
  projectId,
}: {
  journey: Journey;
  hosts: HostItem[];
  projectId: string;
}) {
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

  // One launch key per click, reused verbatim if the HTTP call is retried so a
  // network retry can't spawn a duplicate run.
  const launchKeyRef = useRef<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  const hostName = (id: string) =>
    hosts.find((h) => h.hostId === id)?.name ?? id.slice(0, 8);

  const onRun = async () => {
    if (launching) return;
    setLaunchError(null);
    setLaunching(true);
    if (!launchKeyRef.current) {
      launchKeyRef.current = crypto.randomUUID();
    }
    try {
      await launchJourneyRun({
        journeyId: journey._id,
        projectId,
        launchKey: launchKeyRef.current,
      });
      // Accepted — a fresh key for the next launch.
      launchKeyRef.current = null;
      toast.success("Journey run started");
    } catch (e) {
      if (e instanceof LaunchJourneyRunError && e.status >= 400 && e.status < 500) {
        // 4xx: user-actionable (no hosts, cap edge). Surface inline; KEEP the
        // launch key so a corrected retry stays idempotent.
        setLaunchError(e.message);
      } else {
        launchKeyRef.current = null;
        setLaunchError(
          e instanceof Error ? e.message : "Failed to start run"
        );
      }
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{journey.goal}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {journey.hostIds.map(hostName).join(", ")} ·{" "}
            {journey.config.sessionsPerHost}/host · {journey.config.maxTurns} turns
          </p>
          {rollup && rollup.totalRuns > 0 && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {rollup.totalRuns} run{rollup.totalRuns === 1 ? "" : "s"} total
            </p>
          )}
        </div>
        <Button type="button" size="sm" disabled={launching} onClick={onRun}>
          {launching ? "Starting…" : "Run journey"}
        </Button>
      </div>

      {launchError && (
        <p className="mt-2 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-600 dark:text-red-400">
          {launchError}
        </p>
      )}

      {runs.length > 0 && (
        <div className="mt-3 border-t pt-3">
          {(runs as JourneyRun[]).map((r) => (
            <div key={r._id} className="mb-3 last:mb-0">
              <div className="flex items-center justify-between text-xs">
                <span className={`font-medium ${runStatusClass(r.status)}`}>
                  {r.status}
                </span>
                <span className="text-muted-foreground">
                  {r.summary.succeeded}/{r.summary.total} ok
                  {r.summary.failed > 0 && ` · ${r.summary.failed} failed`}
                  {r.summary.rateLimited > 0 &&
                    ` · ${r.summary.rateLimited} rate-limited`}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {r.hostSummaries.map((hs) => (
                  <span
                    key={hs.hostId}
                    className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                  >
                    {hostName(hs.hostId)}: {hs.succeeded}/{hs.total}
                  </span>
                ))}
                <button
                  type="button"
                  className="text-[11px] font-medium text-primary hover:underline"
                  onClick={() =>
                    setOpenRunId((cur) => (cur === r._id ? null : r._id))
                  }
                >
                  {openRunId === r._id ? "Hide sessions" : "View sessions"}
                </button>
              </div>
              {openRunId === r._id && (
                <RunSessionsView
                  runId={r._id}
                  hosts={hosts}
                  hostSummaries={r.hostSummaries}
                />
              )}
            </div>
          ))}
          {runsStatus === "CanLoadMore" && (
            <button
              type="button"
              className="mt-1 text-[11px] font-medium text-primary hover:underline"
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

// ── sessions by host (per run) ───────────────────────────────────────────────
function RunSessionsView({
  runId,
  hosts,
  hostSummaries,
}: {
  runId: string;
  hosts: HostItem[];
  hostSummaries: JourneyRun["hostSummaries"];
}) {
  // Paginated sessions for this run; grouped/filterable by host client-side.
  const {
    results: sessions,
    status,
    loadMore,
  } = usePaginatedQuery(
    SWARM_QUERIES.listSessionsByJourneyRun as any,
    { runId } as any,
    { initialNumItems: DEFAULT_PAGE_SIZE }
  );
  const [filter, setFilter] = useState<SessionFilterState>(EMPTY_SESSION_FILTER);
  const [selected, setSelected] = useState<JourneySessionRow | null>(null);

  const hostName = (id: string) =>
    hosts.find((h) => h.hostId === id)?.name ?? id.slice(0, 8);

  const rows = sessions as JourneySessionRow[];
  const visible = useMemo(
    () => rows.filter((s) => sessionMatchesFilter(s, filter)),
    [rows, filter]
  );

  return (
    <div className="mt-2 rounded-lg border bg-muted/20 p-2">
      {/* Host filter chips */}
      <div className="mb-2 flex flex-wrap gap-1.5">
        {hostSummaries.map((hs) => (
          <button
            key={hs.hostId}
            type="button"
            onClick={() =>
              setFilter((f) => toggleSessionFilter(f, "hostId", hs.hostId))
            }
            className={`rounded-full border px-2 py-0.5 text-[11px] ${
              filter.hostId === hs.hostId
                ? "border-primary bg-primary/10"
                : "hover:bg-muted"
            }`}
          >
            {hostName(hs.hostId)}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="px-1 py-2 text-[11px] text-muted-foreground">
          No sessions recorded yet for this run.
        </p>
      ) : (
        <div className="flex flex-col divide-y">
          {visible.map((s) => (
            <button
              key={s._id}
              type="button"
              onClick={() => setSelected(s)}
              className={`flex items-center justify-between gap-2 px-1 py-1.5 text-left hover:bg-muted/50 ${
                selected?._id === s._id ? "bg-muted" : ""
              }`}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-[11px] font-medium">
                  {hostName(s.hostId)}
                  {s.personaLabel ? ` · ${s.personaLabel}` : ""}
                </span>
                <span className="truncate text-[10px] text-muted-foreground">
                  {s.status ?? "—"} · {s.messageCount ?? 0} msgs
                </span>
              </span>
              <SessionReadinessBadge
                readiness={s.readiness as SessionReadiness | undefined}
              />
            </button>
          ))}
        </div>
      )}

      {status === "CanLoadMore" && (
        <button
          type="button"
          className="mt-1 text-[11px] font-medium text-primary hover:underline"
          onClick={() => loadMore(DEFAULT_PAGE_SIZE)}
        >
          Load more sessions
        </button>
      )}

      {/* Reuse the existing project-scoped session viewer — do NOT build a new
          one. `ShareUsageThreadDetail` takes the session row's `_id`. */}
      {selected && (
        <div className="mt-2 h-[420px] overflow-hidden rounded-lg border">
          <ShareUsageThreadDetail
            threadId={selected._id}
            sessionLink={`${getShareableAppOrigin()}${buildChatboxSessionPath(
              selected.hostId,
              selected._id,
              routePaths.swarms
            )}`}
          />
        </div>
      )}
    </div>
  );
}

// ── dialogs (minimal inline forms) ───────────────────────────────────────────
function NewPersonaButton({
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
  if (!open) {
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        + New
      </Button>
    );
  }
  return (
    <div className="absolute right-4 top-12 z-10 w-64 rounded-lg border bg-background p-3 shadow-lg">
      <input
        className="mb-2 w-full rounded border px-2 py-1 text-sm"
        placeholder="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className="mb-2 w-full rounded border px-2 py-1 text-sm"
        placeholder="Role"
        value={role}
        onChange={(e) => setRole(e.target.value)}
      />
      <textarea
        className="mb-2 w-full rounded border px-2 py-1 text-sm"
        placeholder="Notes / personality"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!name.trim() || !role.trim()}
          onClick={async () => {
            await onCreate({ name, role, notes });
            setOpen(false);
            setName("");
            setRole("");
            setNotes("");
          }}
        >
          Create
        </Button>
      </div>
    </div>
  );
}

function NewJourneyButton({
  hosts,
  onCreate,
}: {
  hosts: HostItem[];
  onCreate: (draft: {
    goal: string;
    hostIds: string[];
    config: { sessionsPerHost: number; maxTurns: number };
  }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState("");
  const [hostIds, setHostIds] = useState<string[]>([]);
  const [sessionsPerHost, setSessionsPerHost] = useState(2);
  const [maxTurns, setMaxTurns] = useState(6);
  if (!open) {
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        + New journey
      </Button>
    );
  }
  const toggleHost = (id: string) =>
    setHostIds((prev) =>
      prev.includes(id) ? prev.filter((h) => h !== id) : [...prev, id]
    );
  return (
    <div className="w-full rounded-lg border p-4">
      <textarea
        className="mb-3 w-full rounded border px-2 py-1 text-sm"
        placeholder="Goal — what this persona is trying to accomplish"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
      />
      <p className="mb-1 text-xs font-medium">Hosts</p>
      <div className="mb-3 flex flex-wrap gap-2">
        {hosts.length === 0 ? (
          <span className="text-xs text-muted-foreground">
            No hosts in this project.
          </span>
        ) : (
          hosts.map((h) => (
            <button
              key={h.hostId}
              type="button"
              onClick={() => toggleHost(h.hostId)}
              className={`rounded-full border px-2.5 py-1 text-xs ${
                hostIds.includes(h.hostId)
                  ? "border-primary bg-primary/10"
                  : "hover:bg-muted"
              }`}
            >
              {h.name}
            </button>
          ))
        )}
      </div>
      <div className="mb-3 flex gap-4 text-xs">
        <label className="flex items-center gap-1">
          Sessions/host
          <input
            type="number"
            min={1}
            max={5}
            className="w-14 rounded border px-1 py-0.5"
            value={sessionsPerHost}
            onChange={(e) => setSessionsPerHost(Number(e.target.value))}
          />
        </label>
        <label className="flex items-center gap-1">
          Max turns
          <input
            type="number"
            min={1}
            max={20}
            className="w-14 rounded border px-1 py-0.5"
            value={maxTurns}
            onChange={(e) => setMaxTurns(Number(e.target.value))}
          />
        </label>
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
            hostIds.length === 0 ||
            !Number.isInteger(sessionsPerHost) ||
            sessionsPerHost < 1 ||
            sessionsPerHost > 5 ||
            !Number.isInteger(maxTurns) ||
            maxTurns < 1 ||
            maxTurns > 20
          }
          onClick={async () => {
            await onCreate({
              goal,
              hostIds,
              config: { sessionsPerHost, maxTurns },
            });
            setOpen(false);
            setGoal("");
            setHostIds([]);
          }}
        >
          Create journey
        </Button>
      </div>
    </div>
  );
}
