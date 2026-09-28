/**
 * Stop a running swarm wave — the one cancel, shared by every surface that
 * watches a live wave (the create flow's Run swarm step and `/swarms/:id`).
 *
 * A wave is N journey-runs and the backend cancels ONE run per call, so the
 * hook fans out and reports what actually stopped; the button confirms first,
 * because a stop cannot be undone.
 */
import { useCallback, useState } from "react";
import { useMutation } from "convex/react";
import { Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { toast } from "@/lib/toast";
import { convexErrMessage } from "@/lib/convex-error";
import { SWARM_MUTATIONS } from "@/lib/swarm-api";

/**
 * Did `cancelJourneyRun` refuse because the run had already settled?
 *
 * The backend answers `ConvexError({ code: 'CONFLICT' })` for any run whose
 * status is no longer `running`. Matched on the structured `code` rather than
 * on the text: Convex redacts `err.message` for an application error to a
 * Request-ID string, so a message regex would silently never match in prod —
 * the payload on `err.data` is the only reliable carrier.
 */
export function isRunAlreadySettled(reason: unknown): boolean {
  if (!reason || typeof reason !== "object" || !("data" in reason)) {
    return false;
  }
  const data = (reason as { data: unknown }).data;
  return (
    !!data &&
    typeof data === "object" &&
    (data as { code?: unknown }).code === "CONFLICT"
  );
}

/** What a stop did: cancelled something, found it all finished, or was refused. */
export type StopSwarmRunOutcome = "stopped" | "settled" | "refused";

export function useStopSwarmRun(runningRunIds: readonly string[]) {
  const cancelJourneyRun = useMutation(SWARM_MUTATIONS.cancelJourneyRun as any);
  const [busy, setBusy] = useState(false);
  /**
   * This viewer stopped the run, in this visit.
   *
   * The wave reads cannot tell a deliberate stop from a failure — both settle
   * on `issues`. Telling the person who just pressed Stop that their run
   * "Completed with issues" says their action broke something. This is the
   * one piece of positive evidence available, so it is used, and only for as
   * long as it is trustworthy: a reload has no memory of the click and
   * honestly falls back to what the data supports.
   */
  const [stoppedHere, setStoppedHere] = useState(false);

  /**
   * Stop every still-running goal in this wave.
   *
   * `allSettled` rather than `all`, and the report names how many actually
   * stopped instead of claiming the whole wave on the strength of the first
   * success.
   *
   * Three outcomes per goal, not two. `cancelJourneyRun` throws `CONFLICT` for
   * a goal that settled between the click and the call, and that is neither a
   * success nor a refusal: nothing is running, so it is not a goal that "could
   * not be stopped", but this viewer did not stop it either. Counting it as a
   * failure produced an error toast for a run that had, in the viewer's terms,
   * already done what they asked; counting it as a success would put "Stopped"
   * over a goal that COMPLETED, which the backend calls materially wrong.
   */
  const stop = useCallback(async (): Promise<StopSwarmRunOutcome> => {
    if (runningRunIds.length === 0) return "settled";
    setBusy(true);
    try {
      const results = await Promise.allSettled(
        runningRunIds.map((runId) =>
          cancelJourneyRun({ journeyRunId: runId } as any),
        ),
      );
      const rejections = results.flatMap((r) =>
        r.status === "rejected" ? [r.reason] : [],
      );
      // Read off the structured `code`, not the message: for an application
      // error Convex redacts `err.message` to a Request-ID string, which is
      // also why the toast below goes through `convexErrMessage`.
      const refused = rejections.filter(
        (reason) => !isRunAlreadySettled(reason),
      );
      const canceled = results.length - rejections.length;

      // A real refusal outranks the already-settled case. With nothing stopped
      // and one goal genuinely refused, ordering these the other way reported
      // "already finished" and buried the failure the viewer has to act on.
      if (canceled === 0 && refused.length > 0) {
        toast.error(convexErrMessage(refused[0], "Could not stop the run"));
        return "refused";
      }
      if (canceled === 0) {
        // Every goal had already finished on its own. No `stoppedHere`, and
        // not an error either.
        toast.info("Run had already finished");
        return "settled";
      }
      setStoppedHere(true);
      toast.success(
        refused.length === 0
          ? "Run stopped"
          : `Run stopped: ${refused.length} ${
              refused.length === 1 ? "goal" : "goals"
            } could not be stopped`,
      );
      return "stopped";
    } finally {
      setBusy(false);
    }
  }, [cancelJourneyRun, runningRunIds]);

  return { stop, busy, stoppedHere };
}

/**
 * "Stop run", confirmed. A Popover rather than a modal, so the run stays
 * visible behind the decision.
 */
export function StopSwarmRunButton({
  runningCount,
  busy,
  onConfirm,
  testIdPrefix,
}: {
  runningCount: number;
  busy: boolean;
  onConfirm: () => void;
  /** `${prefix}-stop` / `${prefix}-stop-confirm`. */
  testIdPrefix: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="shrink-0 rounded-lg"
          disabled={busy || runningCount === 0}
          data-testid={`${testIdPrefix}-stop`}
        >
          {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
          Stop run
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 max-w-[90vw] p-3">
        <p className="text-sm text-foreground">
          Stop this run? Sessions that have not started yet will not run.
          Results already collected are kept.
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setOpen(false)}
          >
            Keep running
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
            data-testid={`${testIdPrefix}-stop-confirm`}
          >
            Stop run
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
