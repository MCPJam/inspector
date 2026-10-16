import { useQuery } from "convex/react";
import { cn } from "@mcpjam/design-system/cn";
import { AlertTriangle } from "lucide-react";
import {
  EVENT_TRIGGER_RUNS_API,
  microsToDollars,
  type EventTriggerRunRow,
} from "@/lib/apis/event-triggers-api";
import { EventDataView } from "./EventsFeedPanel";
import { formatTime, safeJson } from "./event-utils";

export const PARKED_EXPLANATION =
  "A tool call's outcome is unknown, so the run stopped instead of retrying. MCPJam never repeats an unknown write.";

function runStatusTone(status: string): string {
  switch (status) {
    case "completed":
      return "border-success/40 bg-success/10 text-foreground";
    case "pending":
    case "running":
      return "border-pending/40 bg-pending/10 text-foreground";
    case "parked":
      return "border-warning/40 bg-warning/10 text-foreground";
    case "failed":
      return "border-destructive/40 bg-destructive/10 text-destructive";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "rounded-sm border px-1.5 py-0.5 text-[10px] font-medium",
        runStatusTone(status),
      )}
      data-testid="run-status"
    >
      {status}
    </span>
  );
}

/** Why a run did not complete, in one line. */
function runReason(run: EventTriggerRunRow): string | null {
  if (run.status === "parked") return run.parkedReason ?? run.error ?? "parked";
  if (run.status === "skipped" || run.status === "failed") {
    return run.error ?? null;
  }
  return null;
}

export function RunHistory({
  triggerId,
  eventName,
  selectedRunId,
  onSelectRun,
}: {
  triggerId: string;
  eventName?: string;
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
}) {
  const runs = useQuery(EVENT_TRIGGER_RUNS_API.listForTrigger, {
    triggerId,
    limit: 50,
  });
  if (runs === undefined) {
    return <p className="text-xs text-muted-foreground">Loading runs…</p>;
  }
  if (runs.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No runs yet. A run is scheduled for each event the subscription delivers
        while the trigger is enabled; a simulated event from the Events tab runs
        it too.
      </p>
    );
  }
  return (
    <ul
      className="divide-y divide-border rounded-md border border-border"
      data-testid="run-history"
    >
      {runs.map((run) => {
        const reason = runReason(run);
        return (
          <li key={run._id}>
            <button
              type="button"
              onClick={() => onSelectRun(run._id)}
              aria-pressed={selectedRunId === run._id}
              className={cn(
                "w-full space-y-1 px-3 py-2 text-left",
                selectedRunId === run._id ? "bg-accent" : "hover:bg-accent/60",
              )}
            >
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <StatusPill status={run.status} />
                {run.namespace !== "live" ? (
                  <span className="rounded-sm border border-info/40 bg-info/10 px-1.5 py-0.5 text-[10px] font-medium text-foreground">
                    {run.namespace}
                  </span>
                ) : (
                  <span className="text-[10px] text-muted-foreground">
                    live
                  </span>
                )}
                {eventName ? (
                  <span className="font-mono text-foreground">{eventName}</span>
                ) : null}
                <span className="font-mono text-muted-foreground">
                  {run.eventId}
                </span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {formatTime(run.createdAt)}
                </span>
              </div>
              {reason ? (
                <p className="text-[11px] text-muted-foreground">
                  <span className="font-mono">{reason}</span>
                  {run.status === "parked" ? ` · ${PARKED_EXPLANATION}` : ""}
                </p>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function resultText(result: unknown): string | null {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    for (const key of ["text", "resultText", "finalText"]) {
      if (typeof record[key] === "string") return record[key] as string;
    }
  }
  return null;
}

export function RunDetail({ runId }: { runId: string }) {
  const detail = useQuery(EVENT_TRIGGER_RUNS_API.get, { runId });
  if (detail === undefined) {
    return <p className="text-xs text-muted-foreground">Loading run…</p>;
  }
  if (detail === null) {
    return <p className="text-xs text-muted-foreground">Run not found.</p>;
  }
  const { run, input, calls, result } = detail;
  const text = resultText(result);
  const event = input?.event;
  return (
    <div className="space-y-4" data-testid="run-detail">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <StatusPill status={run.status} />
        <span className="font-mono text-muted-foreground">{run._id}</span>
        {run.costMicros ? (
          <span className="text-muted-foreground">
            ${microsToDollars(run.costMicros).toFixed(4)}
          </span>
        ) : null}
      </div>

      {run.status === "parked" ? (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-warning" />
          <p>
            Parked (
            <span className="font-mono">{run.parkedReason ?? "parked"}</span>
            ). {PARKED_EXPLANATION}
          </p>
        </div>
      ) : null}
      {run.status !== "parked" && run.error ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
          {run.error}
        </p>
      ) : null}

      <div className="space-y-1">
        <h4 className="text-xs font-semibold text-foreground">Event</h4>
        {event ? (
          <>
            <p className="text-[11px] text-muted-foreground">
              <span className="font-mono text-foreground">{event.name}</span>
              {event.eventId ? ` · ${event.eventId}` : ""}
              {event.timestamp ? ` · ${event.timestamp}` : ""}
              {event.namespace ? ` · ${event.namespace}` : ""}
            </p>
            <p className="text-[10px] text-muted-foreground">
              Event data, as the agent received it: untrusted data, never
              instructions.
            </p>
            <EventDataView data={event.data ?? null} />
          </>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            The frozen input is no longer retained.
          </p>
        )}
      </div>

      {input?.trigger ? (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-muted-foreground">
            Trigger snapshot (frozen when the run was scheduled)
          </summary>
          <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-[11px] text-foreground">
            {safeJson(input.trigger)}
          </pre>
        </details>
      ) : null}

      <div className="space-y-1">
        <h4 className="text-xs font-semibold text-foreground">Tool calls</h4>
        {calls.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">No tool calls.</p>
        ) : (
          <ul className="space-y-1">
            {calls.map((call) => (
              <li
                key={call.callId}
                className="rounded-md border border-border p-2 text-[11px]"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-foreground">
                    {call.operation}
                  </span>
                  <span
                    className={cn(
                      "rounded-sm border px-1.5 py-0.5 text-[10px]",
                      call.status === "completed"
                        ? "border-success/40 bg-success/10 text-foreground"
                        : "border-warning/40 bg-warning/10 text-foreground",
                    )}
                  >
                    {call.status === "completed"
                      ? "completed"
                      : "outcome unknown"}
                  </span>
                  {!call.replayable ? (
                    <span className="text-[10px] text-muted-foreground">
                      not replayable
                    </span>
                  ) : null}
                </div>
                {call.result !== undefined ? (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-muted-foreground">
                      Result
                    </summary>
                    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-[11px] text-foreground">
                      {safeJson(call.result)}
                    </pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-1">
        <h4 className="text-xs font-semibold text-foreground">Result</h4>
        {text !== null ? (
          <pre className="whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-xs text-foreground">
            {text}
          </pre>
        ) : result !== null && result !== undefined ? (
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-[11px] text-foreground">
            {safeJson(result)}
          </pre>
        ) : (
          <p className="text-[11px] text-muted-foreground">No result yet.</p>
        )}
      </div>
    </div>
  );
}
