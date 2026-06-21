import { useEffect, useRef, useState } from "react";
import { usePostHog } from "posthog-js/react";
import { useAuth } from "@workos-inc/authkit-react";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Sparkles } from "lucide-react";
import type { ChatboxSettings } from "@/hooks/useChatboxes";
import { isMCPJamProvidedModel } from "@/shared/types";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { standardEventProps } from "@/lib/PosthogUtils";
import {
  PersonaCard,
  usePersonaRoster,
  useSortedRoster,
} from "@/components/chatboxes/personas";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:6274";

interface PersonaSlate {
  id: string;
  name: string;
  role: string;
  notes: string;
}

interface PersonaEditState extends PersonaSlate {
  selected: boolean;
}

interface RunStatus {
  status: "running" | "completed" | "partial" | "failed" | "rate_limited";
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    rateLimited: number;
  };
  error?: string;
}

type DialogStage = "configure" | "review" | "running";

interface GenerateSessionsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  chatbox: ChatboxSettings;
  /**
   * Phase 2: when launched from the Personas tab "Run swarm" with characters
   * already selected, the dialog opens straight at the Review stage seeded with
   * these personas (skipping roster selection / generation). The `/start`
   * payload is unchanged — these flow through as inline personas.
   */
  initialPersonas?: PersonaSlate[];
}

export function GenerateSessionsDialog({
  isOpen,
  onClose,
  chatbox,
  initialPersonas,
}: GenerateSessionsDialogProps) {
  const { getAccessToken } = useAuth();
  const posthog = usePostHog();

  const [stage, setStage] = useState<DialogStage>("configure");
  const [personaCount, setPersonaCount] = useState(3);
  const [sessionsPerPersona, setSessionsPerPersona] = useState(2);
  const [maxTurns, setMaxTurns] = useState(6);
  const [generating, setGenerating] = useState(false);
  const [starting, setStarting] = useState(false);
  const [personas, setPersonas] = useState<PersonaEditState[]>([]);
  const [running, setRunning] = useState<RunStatus | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  // Stage 1 roster selection (Phase 2).
  const [rosterSelected, setRosterSelected] = useState<Set<string>>(new Set());
  const roster = useSortedRoster(usePersonaRoster(chatbox.chatboxId));
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const runStartAt = useRef<number>(0);
  // Guards `chatbox_simulate_sessions_completed` against firing more than
  // once if a poll re-runs after the run is already in a terminal state.
  // Ref (not state) so the guard is checked synchronously inside the poll
  // callback without depending on a re-render.
  const completionAnalyticsFired = useRef(false);
  // Seed the preselected personas exactly once per open cycle. Without this,
  // a Convex roster refetch (or any new `initialPersonas` array identity) while
  // the dialog is open would re-run the effect and snap the stage back to
  // "review" — clobbering an in-progress run, the "Back" navigation, or edits.
  const seededForOpenRef = useRef(false);

  useEffect(() => {
    if (!isOpen) {
      setStage("configure");
      setPersonas([]);
      setRunning(null);
      setRunId(null);
      setPollError(null);
      setStarting(false);
      setRosterSelected(new Set());
      completionAnalyticsFired.current = false;
      seededForOpenRef.current = false;
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
      return;
    }
    // Opened from "Run swarm" with characters preselected — seed Review once.
    if (
      !seededForOpenRef.current &&
      initialPersonas &&
      initialPersonas.length > 0
    ) {
      seededForOpenRef.current = true;
      setPersonas(initialPersonas.map((p) => ({ ...p, selected: true })));
      setStage("review");
    }
  }, [isOpen, initialPersonas]);

  // Server selection lives on the backend: the dialog forwards the full
  // chatbox server list and the start route filters optionals out so the
  // synthetic run matches what a real visitor with no opt-ins would see.
  // With no required servers the run still proceeds: personas are grounded
  // in the chatbox name only and sessions run toolless.
  const serversPayload = chatbox.servers.map((s) => ({
    serverId: s.serverId,
    serverName: s.serverName,
    optional: s.optional === true,
  }));
  const hasRequiredServers = serversPayload.some((s) => !s.optional);

  // BYOK is now supported on synthetic runs — the runner dispatches
  // org-BYOK models through /stream/org (or local-usage writeback) and
  // the backend forwarder stamps synthesisRunId onto the resulting
  // llmUsageRecord. The flag is kept to (a) show a spend-warning
  // notice so users know provider credits will be consumed, and (b)
  // render the rough cost preview below.
  const isByokChatbox = !isMCPJamProvidedModel(chatbox.modelId);

  // Rough cost estimate (not an upper bound — uses a single blended
  // midpoint rate with no safety multiplier, so it can under-estimate
  // real spend if the model is on the expensive end). There's no
  // per-model cost catalog on the client today (SUPPORTED_MODELS doesn't
  // expose pricing); follow-up should swap in per-model pricing from a
  // shared catalog once one exists.
  const ESTIMATED_TOKENS_PER_TURN = 4000; // input + output combined
  const ESTIMATED_USD_PER_1K_TOKENS = 0.005; // coarse blended midpoint
  const totalTurnsUpperBound = personaCount * sessionsPerPersona * maxTurns;
  const estimatedCostUsd =
    (totalTurnsUpperBound *
      ESTIMATED_TOKENS_PER_TURN *
      ESTIMATED_USD_PER_1K_TOKENS) /
    1000;
  const formatUsd = (value: number): string => {
    if (value < 0.01) return "< $0.01";
    if (value < 1) return `$${value.toFixed(2)}`;
    return `$${value.toFixed(2)}`;
  };

  function handleUseRoster() {
    const chosen = (roster ?? []).filter((p) => rosterSelected.has(p._id));
    if (chosen.length === 0) return;
    setPersonas(
      chosen.map((p) => ({
        id: p.personaId,
        name: p.name,
        role: p.role,
        notes: p.notes,
        selected: true,
      }))
    );
    setStage("review");
  }

  async function authHeader(): Promise<Record<string, string>> {
    const token = await getAccessToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function handleGenerate() {
    setGenerating(true);
    posthog.capture("chatbox_generate_personas_started", {
      ...standardEventProps("chatbox_usage_panel"),
      chatbox_id: chatbox.chatboxId,
      persona_count: personaCount,
    });
    try {
      const response = await fetch(
        `${API_BASE}/api/web/chatboxes/${chatbox.chatboxId}/generate-personas`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(await authHeader()),
          },
          body: JSON.stringify({
            projectId: chatbox.projectId,
            servers: serversPayload,
            personaCount,
            chatboxName: chatbox.name,
          }),
        }
      );
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text);
      }
      const data = (await response.json()) as { personas: PersonaSlate[] };
      setPersonas(data.personas.map((p) => ({ ...p, selected: true })));
      setStage("review");
      posthog.capture("chatbox_generate_personas_completed", {
        ...standardEventProps("chatbox_usage_panel"),
        chatbox_id: chatbox.chatboxId,
        persona_count: data.personas.length,
        success: true,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to generate personas";
      toast.error(message);
      posthog.capture("chatbox_generate_personas_completed", {
        ...standardEventProps("chatbox_usage_panel"),
        chatbox_id: chatbox.chatboxId,
        persona_count: personaCount,
        success: false,
      });
    } finally {
      setGenerating(false);
    }
  }

  async function handleRun() {
    if (starting) return;
    const selected = personas.filter((p) => p.selected);
    if (selected.length === 0) {
      toast.error("Select at least one persona");
      return;
    }
    const totalSessions = selected.length * sessionsPerPersona;
    runStartAt.current = Date.now();
    setStarting(true);
    try {
      const response = await fetch(
        `${API_BASE}/api/web/chatboxes/${chatbox.chatboxId}/simulate-sessions/start`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(await authHeader()),
          },
          body: JSON.stringify({
            projectId: chatbox.projectId,
            servers: serversPayload,
            personas: selected.map(({ selected: _, ...rest }) => rest),
            sessionsPerPersona,
            maxTurns,
          }),
        }
      );
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text);
      }
      const data = (await response.json()) as { runId: string };
      setRunId(data.runId);
      posthog.capture("chatbox_simulate_sessions_started", {
        ...standardEventProps("chatbox_usage_panel"),
        chatbox_id: chatbox.chatboxId,
        run_id: data.runId,
        selected_persona_count: selected.length,
        total_sessions: totalSessions,
      });
      setRunning({
        status: "running",
        summary: {
          total: totalSessions,
          succeeded: 0,
          failed: 0,
          rateLimited: 0,
        },
      });
      setStage("running");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to start simulation";
      toast.error(message);
    } finally {
      setStarting(false);
    }
  }

  useEffect(() => {
    if (!runId || !isOpen) return;
    if (pollTimer.current) clearInterval(pollTimer.current);
    pollTimer.current = setInterval(async () => {
      try {
        const response = await fetch(
          `${API_BASE}/api/web/chatboxes/${
            chatbox.chatboxId
          }/simulate-sessions/${runId}?projectId=${encodeURIComponent(
            chatbox.projectId
          )}`,
          {
            method: "GET",
            headers: {
              ...(await authHeader()),
            },
          }
        );
        if (!response.ok) {
          setPollError(`Last update failed (${response.status})`);
          return;
        }
        const data = (await response.json()) as {
          run: RunStatus;
        };
        setPollError(null);
        setRunning(data.run);
        if (data.run.status !== "running") {
          // Clear the timer first so a late same-tick scheduling can't
          // re-enter and re-fire analytics before the guard ref flips.
          if (pollTimer.current) {
            clearInterval(pollTimer.current);
            pollTimer.current = null;
          }
          if (!completionAnalyticsFired.current) {
            completionAnalyticsFired.current = true;
            posthog.capture("chatbox_simulate_sessions_completed", {
              ...standardEventProps("chatbox_usage_panel"),
              chatbox_id: chatbox.chatboxId,
              run_id: runId,
              sessions_created: data.run.summary.succeeded,
              sessions_failed: data.run.summary.failed,
              sessions_rate_limited: data.run.summary.rateLimited,
              duration_ms: Date.now() - runStartAt.current,
            });
          }
        }
      } catch {
        // Errors may be transient; surface a recoverable message but keep
        // polling so a momentary network blip doesn't abandon the run.
        setPollError("Last update failed");
      }
    }, 1000);
    return () => {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
    // `chatbox.projectId` is read inside the poll URL; include it so a
    // (rare) projectId swap on the same chatboxId doesn't stale-close.
  }, [runId, isOpen, chatbox.chatboxId, chatbox.projectId, posthog]);

  function updatePersona(
    index: number,
    patch: Partial<PersonaEditState>
  ): void {
    setPersonas((prev) =>
      prev.map((p, i) => (i === index ? { ...p, ...patch } : p))
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4" />
            Generate sessions with AI
          </DialogTitle>
          <DialogDescription>
            Spawn realistic personas and run multi-turn chats against this
            chatbox&apos;s live MCP servers.
          </DialogDescription>
        </DialogHeader>

        {stage === "configure" ? (
          <div className="space-y-4">
            {/* Stage 1 — roster selection. Pick saved characters to run, or
                generate a fresh slate below. */}
            {roster && roster.length > 0 ? (
              <div className="space-y-2">
                <Label>Run saved characters</Label>
                <div className="grid max-h-[240px] grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
                  {roster.map((persona) => (
                    <PersonaCard
                      key={persona._id}
                      persona={persona}
                      selected={rosterSelected.has(persona._id)}
                      onToggle={() =>
                        setRosterSelected((prev) => {
                          const next = new Set(prev);
                          if (next.has(persona._id)) next.delete(persona._id);
                          else next.add(persona._id);
                          return next;
                        })
                      }
                    />
                  ))}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    {rosterSelected.size} selected
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={rosterSelected.size === 0}
                    onClick={handleUseRoster}
                  >
                    Review selected ({rosterSelected.size})
                  </Button>
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <div className="h-px flex-1 bg-border" />
                  <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    or generate new
                  </span>
                  <div className="h-px flex-1 bg-border" />
                </div>
              </div>
            ) : null}

            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label htmlFor="persona-count">Personas</Label>
                <Input
                  id="persona-count"
                  type="number"
                  min={1}
                  max={10}
                  value={personaCount}
                  onChange={(e) =>
                    setPersonaCount(
                      Math.max(1, Math.min(10, Number(e.target.value) || 1))
                    )
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sessions-per-persona">Sessions / persona</Label>
                <Input
                  id="sessions-per-persona"
                  type="number"
                  min={1}
                  max={5}
                  value={sessionsPerPersona}
                  onChange={(e) =>
                    setSessionsPerPersona(
                      Math.max(1, Math.min(5, Number(e.target.value) || 1))
                    )
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="max-turns">Max turns</Label>
                <Input
                  id="max-turns"
                  type="number"
                  min={1}
                  max={20}
                  value={maxTurns}
                  onChange={(e) =>
                    setMaxTurns(
                      Math.max(1, Math.min(20, Number(e.target.value) || 1))
                    )
                  }
                />
              </div>
            </div>

            {isByokChatbox ? (
              <>
                <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <span>
                    This chatbox uses your organization&apos;s model key.
                    Running synthetic sessions will consume your provider
                    credits.
                  </span>
                </div>

                <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                  <div className="flex items-center justify-between gap-2">
                    <span>Rough cost estimate</span>
                    <span className="font-medium text-foreground">
                      {formatUsd(estimatedCostUsd)}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] opacity-80">
                    {totalTurnsUpperBound} turns ({personaCount} ×{" "}
                    {sessionsPerPersona} × {maxTurns}) at a coarse blended rate.
                    Actuals depend on the model and conversation length and can
                    vary above this number.
                  </div>
                </div>
              </>
            ) : null}

            {chatbox.requireToolApproval ? (
              <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>
                  Synthetic sessions cannot exercise approval-required tools.
                  The persona will only see meta/discovery tools.
                </span>
              </div>
            ) : null}

            {!hasRequiredServers ? (
              <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                No required servers attached — personas are generated from the
                chatbox name only, and sessions run without tools.
              </div>
            ) : null}

            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleGenerate} disabled={generating}>
                {generating ? (
                  <>
                    <Loader2 className="mr-1 size-3 animate-spin" /> Generating
                  </>
                ) : (
                  "Generate personas"
                )}
              </Button>
            </div>
          </div>
        ) : null}

        {stage === "review" ? (
          <div className="space-y-3">
            <div className="grid max-h-[400px] grid-cols-1 gap-2 overflow-y-auto pr-1">
              {personas.map((persona, index) => (
                <div key={persona.id} className="rounded-md border p-3 text-sm">
                  <div className="flex items-start gap-2">
                    <Checkbox
                      checked={persona.selected}
                      onCheckedChange={(checked) =>
                        updatePersona(index, { selected: checked === true })
                      }
                      className="mt-1"
                    />
                    <div className="flex-1 space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        <Input
                          value={persona.name}
                          onChange={(e) =>
                            updatePersona(index, { name: e.target.value })
                          }
                          placeholder="Persona"
                        />
                        <Input
                          value={persona.role}
                          onChange={(e) =>
                            updatePersona(index, { role: e.target.value })
                          }
                          placeholder="Context"
                        />
                      </div>
                      <Textarea
                        value={persona.notes}
                        onChange={(e) =>
                          updatePersona(index, { notes: e.target.value })
                        }
                        placeholder="Notes — context, goals, quirks"
                        rows={2}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-between">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setStage("configure")}
              >
                Back
              </Button>
              <Button size="sm" onClick={handleRun} disabled={starting}>
                {starting ? (
                  <>
                    <Loader2 className="mr-1 size-3 animate-spin" /> Starting
                  </>
                ) : (
                  "Run simulation"
                )}
              </Button>
            </div>
          </div>
        ) : null}

        {stage === "running" && running ? (
          <div className="space-y-3">
            <div className="space-y-1">
              <p
                className={
                  running.status === "rate_limited"
                    ? "text-sm font-medium text-amber-700 dark:text-amber-400"
                    : "text-sm font-medium"
                }
              >
                {running.status === "running"
                  ? "Running…"
                  : running.status === "completed"
                  ? "Done"
                  : running.status === "partial"
                  ? "Completed partially"
                  : running.status === "rate_limited"
                  ? "Rate-limited — budget reached"
                  : "Failed"}
              </p>
              <p className="text-xs text-muted-foreground">
                {running.summary.succeeded +
                  running.summary.failed +
                  running.summary.rateLimited}{" "}
                / {running.summary.total} sessions
                {running.summary.failed > 0
                  ? ` · ${running.summary.failed} failed`
                  : ""}
                {running.summary.rateLimited > 0
                  ? ` · ${running.summary.rateLimited} rate-limited`
                  : ""}
              </p>
              {running.error ? (
                <p className="text-xs text-destructive">{running.error}</p>
              ) : null}
              {pollError && running.status === "running" ? (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  {pollError} — retrying…
                </p>
              ) : null}
            </div>
            <div className="flex justify-end">
              {/* When polling fails we re-enable Close so the user isn't
                  trapped in a stuck "Working…" state if the backend goes
                  unreachable. Polling continues in the background. */}
              <Button
                size="sm"
                onClick={onClose}
                disabled={running.status === "running" && !pollError}
              >
                {running.status !== "running"
                  ? "View sessions"
                  : pollError
                  ? "Close"
                  : "Working…"}
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
