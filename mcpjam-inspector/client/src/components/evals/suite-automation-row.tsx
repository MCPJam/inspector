/**
 * The suite's schedule, read as an AUTOMATION rather than a checkbox.
 *
 * THE PROBLEM THIS SOLVES. The row said "Scheduled runs off" beside an interval
 * dropdown, which is everything a schedule is except the three things that
 * actually go wrong with one:
 *
 *   - it runs AS A PERSON. Scheduled runs use the access of whoever enabled
 *     them, and the schedule pauses itself when that person loses it. Nothing
 *     on the page said whose access was being spent, so nobody knew that a
 *     colleague leaving would stop their monitoring.
 *   - it PAUSES ITSELF, and keeps `enabled: true` when it does. A reader who
 *     saw the switch in the on position had no way to learn the suite had not
 *     run in a week.
 *   - it has a HISTORY. "Did this actually fire, and did it pass?" was a
 *     question the settings row could not answer at all.
 *
 * So this row leads with the state, names the person, shows when the next run
 * is due and how the last few went, and keeps the full editor one click away.
 * The editor itself is unchanged — it writes immediately, with its own
 * validation, which is why this row says so rather than joining the draft.
 */

import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { toast } from "@/lib/toast";
import {
  PAUSE_COPY,
  ScheduleEditor,
  type SuiteSchedule,
} from "./schedule-editor";
import type { EvalSuiteRun } from "./types";

/** How many past scheduled runs the row shows as result dots. */
const RECENT_SCHEDULED_RUNS = 5;

/**
 * The dot for one past scheduled run.
 *
 * `inconclusive`, `cancelled` and `timed_out` are NEUTRAL, never red. An
 * inconclusive run is one the suite could not measure well enough to decide,
 * and painting it as a failure blames the server for the grader — the exact
 * conflation verdict policy v2 exists to stop.
 */
function runDotClass(result: EvalSuiteRun["result"]): string {
  if (result === "passed") return "bg-success";
  if (result === "failed") return "bg-destructive";
  return "bg-muted-foreground/40";
}

/** A future timestamp as "in 4m" / "in 3h"; past or absent renders "—". */
export function formatNextDue(
  nextDueAt: number | undefined,
  now = Date.now(),
): string {
  if (!nextDueAt) return "—";
  const deltaMs = nextDueAt - now;
  if (deltaMs <= 0) return "due now";
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return "in under a minute";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/** The chip a schedule's state earns. */
function stateChip(schedule: SuiteSchedule | undefined): {
  label: string;
  detail: string | null;
  tone: string;
} {
  if (!schedule || !schedule.enabled) {
    return { label: "Off", detail: null, tone: "text-muted-foreground" };
  }
  if (schedule.state === "active") {
    return { label: "Active", detail: null, tone: "text-success" };
  }
  return {
    label: "Paused",
    // The state's own sentence, from the editor's map — one copy, so the chip
    // and the resume banner below cannot tell a reader two different stories.
    detail: PAUSE_COPY[schedule.state],
    tone: "text-amber-700 dark:text-amber-400",
  };
}

export function SuiteAutomationRow({
  suiteId,
  schedule,
  scheduleNextDueAt,
  runs,
  userMap,
  projectId = null,
  environmentIds,
  canTakeOver = true,
}: {
  suiteId: string;
  schedule: SuiteSchedule | undefined;
  /** Epoch ms of the next due firing, from the suite document. */
  scheduleNextDueAt?: number;
  /** The suite's runs; this row reads only the scheduled ones. */
  runs: EvalSuiteRun[];
  /** Display names, already loaded by the suite page. */
  userMap?: Map<string, { name: string; imageUrl?: string }>;
  projectId?: string | null;
  environmentIds?: string[];
  /** False when the caller may not change the schedule. */
  canTakeOver?: boolean;
}) {
  const [manageOpen, setManageOpen] = useState(false);
  const [isWriting, setIsWriting] = useState(false);

  const setSuiteSchedule = useMutation(
    "testSuites:setSuiteSchedule" as never,
  ) as unknown as (args: {
    suiteId: string;
    enabled: boolean;
    intervalMinutes?: number;
    environmentId?: string;
  }) => Promise<unknown>;
  const reassignScheduleOwner = useMutation(
    "testSuites:reassignScheduleOwner" as never,
  ) as unknown as (args: { suiteId: string }) => Promise<unknown>;

  const chip = stateChip(schedule);
  const ownerId = schedule?.createdByUserId;
  // A schedule whose owner is gone still has to READ as something. "a former
  // member" is the honest rendering: the row's whole point is that a schedule
  // spends somebody's access, and a bare id would hide that this one no longer
  // has anybody's.
  const ownerName = ownerId
    ? (userMap?.get(ownerId)?.name ?? "a former member")
    : null;

  const recentScheduledRuns = useMemo(
    () =>
      runs
        .filter((run) => run.source === "schedule")
        .slice(0, RECENT_SCHEDULED_RUNS),
    [runs],
  );

  const write = async (fn: () => Promise<unknown>, success: string) => {
    setIsWriting(true);
    try {
      await fn();
      toast.success(success);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to update the schedule",
      );
    } finally {
      setIsWriting(false);
    }
  };

  const enabled = schedule?.enabled === true;
  const pausedForAuth = enabled && schedule?.state === "paused_auth";
  // A schedule that paused ITSELF keeps `enabled: true` — the state, not the
  // switch, says it stopped. Offering "Pause" beside a "Paused" chip gave the
  // reader nothing to do; the way forward is Resume (an enabled write resets
  // the failure counter and the clock), except for `paused_auth`, where only
  // Take over can mint the missing delegation.
  const pausedByItself =
    enabled && schedule?.state !== undefined && schedule.state !== "active";
  const offersResume = !enabled || (pausedByItself && !pausedForAuth);

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <span className={`text-xs font-medium ${chip.tone}`}>
              {chip.label}
            </span>
            {ownerName ? (
              <span className="text-[11px] text-muted-foreground">
                Runs as {ownerName} · pauses if they leave the organization
              </span>
            ) : null}
          </div>
          {chip.detail ? (
            <p className="text-[11px] text-amber-700 dark:text-amber-400">
              {chip.detail}
            </p>
          ) : null}
          <p className="text-[11px] text-muted-foreground/60">
            Next run: {enabled ? formatNextDue(scheduleNextDueAt) : "—"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!offersResume ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={isWriting}
              onClick={() =>
                void write(
                  () => setSuiteSchedule({ suiteId, enabled: false }),
                  "Schedule paused",
                )
              }
            >
              Pause
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={isWriting || !schedule}
              onClick={() =>
                void write(
                  () =>
                    setSuiteSchedule({
                      suiteId,
                      enabled: true,
                      ...(schedule?.intervalMinutes
                        ? { intervalMinutes: schedule.intervalMinutes }
                        : {}),
                      ...(schedule?.environmentId
                        ? { environmentId: schedule.environmentId }
                        : {}),
                    }),
                  "Schedule resumed",
                )
              }
            >
              Resume
            </Button>
          )}
          {pausedForAuth && canTakeOver ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={isWriting}
              onClick={() =>
                void write(
                  () => reassignScheduleOwner({ suiteId }),
                  "Schedule now runs as you",
                )
              }
            >
              Take over
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            onClick={() => setManageOpen(true)}
          >
            Manage
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground/60">
          Recent scheduled runs
        </span>
        {recentScheduledRuns.length === 0 ? (
          <span className="text-[11px] text-muted-foreground/60">none yet</span>
        ) : (
          <span
            className="flex items-center gap-1"
            data-testid="schedule-run-dots"
          >
            {recentScheduledRuns.map((run) => (
              <span
                key={run._id}
                className={`h-2 w-2 rounded-full ${runDotClass(run.result)}`}
                data-run-result={run.result ?? "pending"}
                title={run.result ?? "pending"}
              />
            ))}
          </span>
        )}
      </div>

      <Dialog open={manageOpen} onOpenChange={setManageOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Schedule</DialogTitle>
            <DialogDescription>
              Saves immediately — this editor writes as you change it, with its
              own validation.
            </DialogDescription>
          </DialogHeader>
          <ScheduleEditor
            suiteId={suiteId}
            schedule={schedule}
            projectId={projectId}
            environmentIds={environmentIds}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
