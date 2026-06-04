import { useEffect, useRef, useState } from "react";
import { usePostHog } from "posthog-js/react";
import { useAuth } from "@workos-inc/authkit-react";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Sparkles } from "lucide-react";
import type { ChatboxSettings } from "@/hooks/useChatboxes";
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
  status: "running" | "completed" | "partial" | "failed";
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
}

export function GenerateSessionsDialog({
  isOpen,
  onClose,
  chatbox,
}: GenerateSessionsDialogProps) {
  const { getAccessToken } = useAuth();
  const posthog = usePostHog();

  const [stage, setStage] = useState<DialogStage>("configure");
  const [personaCount, setPersonaCount] = useState(3);
  const [sessionsPerPersona, setSessionsPerPersona] = useState(2);
  const [maxTurns, setMaxTurns] = useState(6);
  const [generating, setGenerating] = useState(false);
  const [personas, setPersonas] = useState<PersonaEditState[]>([]);
  const [running, setRunning] = useState<RunStatus | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const runStartAt = useRef<number>(0);

  useEffect(() => {
    if (!isOpen) {
      setStage("configure");
      setPersonas([]);
      setRunning(null);
      setRunId(null);
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    }
  }, [isOpen]);

  const serverIds = chatbox.servers.map((s) => s.serverId);
  const serverNames = chatbox.servers.map((s) => s.serverName);
  const hasServers = serverIds.length > 0;

  async function authHeader(): Promise<Record<string, string>> {
    const token = await getAccessToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function handleGenerate() {
    if (!hasServers) return;
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
            selectedServerIds: serverIds,
            selectedServerNames: serverNames,
            personaCount,
          }),
        },
      );
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text);
      }
      const data = (await response.json()) as { personas: PersonaSlate[] };
      setPersonas(
        data.personas.map((p) => ({ ...p, selected: true })),
      );
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
    const selected = personas.filter((p) => p.selected);
    if (selected.length === 0) {
      toast.error("Select at least one persona");
      return;
    }
    const totalSessions = selected.length * sessionsPerPersona;
    runStartAt.current = Date.now();
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
            selectedServerIds: serverIds,
            selectedServerNames: serverNames,
            personas: selected.map(({ selected: _, ...rest }) => rest),
            sessionsPerPersona,
            maxTurns,
          }),
        },
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
    }
  }

  useEffect(() => {
    if (!runId || !isOpen) return;
    if (pollTimer.current) clearInterval(pollTimer.current);
    pollTimer.current = setInterval(async () => {
      try {
        const response = await fetch(
          `${API_BASE}/api/web/chatboxes/${chatbox.chatboxId}/simulate-sessions/${runId}`,
          {
            method: "GET",
            headers: {
              ...(await authHeader()),
            },
          },
        );
        if (!response.ok) return;
        const data = (await response.json()) as {
          run: RunStatus;
        };
        setRunning(data.run);
        if (data.run.status !== "running") {
          if (pollTimer.current) {
            clearInterval(pollTimer.current);
            pollTimer.current = null;
          }
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
      } catch {
        // network blips are tolerable
      }
    }, 1000);
    return () => {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [runId, isOpen, chatbox.chatboxId, posthog]);

  function updatePersona(
    index: number,
    patch: Partial<PersonaEditState>,
  ): void {
    setPersonas((prev) =>
      prev.map((p, i) => (i === index ? { ...p, ...patch } : p)),
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
                      Math.max(1, Math.min(10, Number(e.target.value) || 1)),
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
                      Math.max(1, Math.min(5, Number(e.target.value) || 1)),
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
                      Math.max(1, Math.min(20, Number(e.target.value) || 1)),
                    )
                  }
                />
              </div>
            </div>

            {chatbox.requireToolApproval ? (
              <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>
                  Approval-required tools will be auto-denied during synthetic
                  runs.
                </span>
              </div>
            ) : null}

            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleGenerate}
                disabled={!hasServers || generating}
              >
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
                <div
                  key={persona.id}
                  className="rounded-md border p-3 text-sm"
                >
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
                          placeholder="Name"
                        />
                        <Input
                          value={persona.role}
                          onChange={(e) =>
                            updatePersona(index, { role: e.target.value })
                          }
                          placeholder="Role"
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
              <Button size="sm" onClick={handleRun}>
                Run simulation
              </Button>
            </div>
          </div>
        ) : null}

        {stage === "running" && running ? (
          <div className="space-y-3">
            <div className="space-y-1">
              <p className="text-sm font-medium">
                {running.status === "running"
                  ? "Running…"
                  : running.status === "completed"
                    ? "Done"
                    : running.status === "partial"
                      ? "Completed partially"
                      : "Failed"}
              </p>
              <p className="text-xs text-muted-foreground">
                {running.summary.succeeded + running.summary.failed +
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
            </div>
            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={onClose}
                disabled={running.status === "running"}
              >
                {running.status === "running" ? "Working…" : "View sessions"}
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
