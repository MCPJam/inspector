/**
 * Project-scoped Swarms surface (redesign): Persona → Journey → Run.
 *
 * Replaces the old host-anchored `ChatboxesTab product="swarm"`. Personas and
 * journeys live at the project level; a journey targets one-or-more hosts and,
 * when run, fans out one single-host session per (host × sessionsPerHost).
 *
 * Consumes the project-scoped backend: personas:*, journeys:*, journeyRuns:*.
 */
import { useMemo, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { toast } from "@/lib/toast";

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
type JourneyRun = {
  _id: string;
  status: string;
  summary: { total: number; succeeded: number; failed: number; rateLimited: number };
  hostSummaries: Array<{
    hostId: string;
    total: number;
    succeeded: number;
    failed: number;
    rateLimited: number;
  }>;
  createdAt: number;
};
type HostItem = { hostId: string; name: string };

interface SwarmsTabProps {
  projectId: string | null;
  isAuthenticated: boolean;
}

// ── hooks ─────────────────────────────────────────────────────────────────
function usePersonas(projectId: string | null) {
  return useQuery(
    "personas:listPersonas" as any,
    projectId ? ({ projectId } as any) : "skip"
  ) as Persona[] | undefined;
}
function useJourneys(personaRefId: string | null) {
  return useQuery(
    "journeys:listJourneysByPersona" as any,
    personaRefId ? ({ personaRefId } as any) : "skip"
  ) as Journey[] | undefined;
}
function useProjectHosts(projectId: string | null) {
  return useQuery(
    "hosts:listHosts" as any,
    projectId ? ({ projectId } as any) : "skip"
  ) as HostItem[] | undefined;
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
                  await deletePersona({ personaRefId: selectedPersona._id } as any);
                  setSelectedPersonaId(null);
                }}
              >
                Delete persona
              </Button>
            </div>

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
                  <JourneyCard key={j._id} journey={j} hosts={hosts ?? []} />
                ))}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

// ── journey card + runs ──────────────────────────────────────────────────────
function JourneyCard({
  journey,
  hosts,
}: {
  journey: Journey;
  hosts: HostItem[];
}) {
  const runs = useQuery(
    "journeyRuns:listJourneyRuns" as any,
    { journeyRefId: journey._id, paginationOpts: { numItems: 10, cursor: null } } as any
  ) as { page: JourneyRun[] } | undefined;
  const createJourneyRun = useMutation("journeyRuns:createJourneyRun" as any);
  const [running, setRunning] = useState(false);
  const hostName = (id: string) =>
    hosts.find((h) => h.hostId === id)?.name ?? id.slice(0, 8);

  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{journey.goal}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {journey.hostIds.map(hostName).join(", ")} ·{" "}
            {journey.config.sessionsPerHost}/host · {journey.config.maxTurns} turns
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          // Disabled until the fan-out execution runner + route land (next PR).
          // Creating a run now would leave a permanently-`running` record with
          // pending attempts and no executor.
          disabled
          title="Execution runner ships in the next PR"
          onClick={async () => {
            setRunning(true);
            try {
              await createJourneyRun({ journeyRefId: journey._id } as any);
              toast.success("Journey run started");
            } catch (e) {
              toast.error(
                e instanceof Error ? e.message : "Failed to start run"
              );
            } finally {
              setRunning(false);
            }
          }}
        >
          {running ? "Starting…" : "Run (soon)"}
        </Button>
      </div>
      {runs && runs.page.length > 0 && (
        <div className="mt-3 border-t pt-3">
          {runs.page.slice(0, 3).map((r) => (
            <div key={r._id} className="mb-2 last:mb-0">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium">{r.status}</span>
                <span className="text-muted-foreground">
                  {r.summary.succeeded}/{r.summary.total} ok
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-2">
                {r.hostSummaries.map((hs) => (
                  <span
                    key={hs.hostId}
                    className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                  >
                    {hostName(hs.hostId)}: {hs.succeeded}/{hs.total}
                  </span>
                ))}
              </div>
            </div>
          ))}
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
