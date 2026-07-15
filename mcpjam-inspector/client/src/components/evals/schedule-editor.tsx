/**
 * Suite schedule editor (synthetic monitors) — rendered as a section of the
 * suite settings sheet, behind the `synthetic-monitors` PostHog flag.
 *
 * Scheduled runs execute the WHOLE suite on a fixed interval under the
 * enabling user's identity (org-scoped delegated token; LLM cases bill the
 * organization's model config). Pause states surface here with a one-click
 * resume; resume resets the failure counter and the clock.
 */

import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "@/lib/toast";
import { Button } from "@mcpjam/design-system/button";
import { Switch } from "@mcpjam/design-system/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";

const INTERVAL_OPTIONS: Array<{ minutes: number; label: string }> = [
  { minutes: 5, label: "Every 5 minutes" },
  { minutes: 15, label: "Every 15 minutes" },
  { minutes: 30, label: "Every 30 minutes" },
  { minutes: 60, label: "Every hour" },
  { minutes: 360, label: "Every 6 hours" },
  { minutes: 1440, label: "Daily" },
];

export type SuiteSchedule = {
  intervalMinutes: number;
  enabled: boolean;
  state: "active" | "paused_quota" | "paused_auth" | "paused_failures";
  consecutiveFailures?: number;
};

const PAUSE_COPY: Record<Exclude<SuiteSchedule["state"], "active">, string> = {
  paused_quota:
    "Paused — the organization's eval iteration quota was exhausted. Resume after the quota resets or upgrade the plan.",
  paused_auth:
    "Paused — scheduled runs could no longer authenticate (the scheduling user may have left the organization). Resuming re-pins the schedule to you.",
  paused_failures:
    "Paused automatically after repeated consecutive failures. Fix the underlying issue, then resume.",
};

export function ScheduleEditor({
  suiteId,
  schedule,
}: {
  suiteId: string;
  schedule: SuiteSchedule | undefined;
}) {
  const setSuiteSchedule = useMutation(
    "testSuites:setSuiteSchedule" as any,
  ) as unknown as (args: {
    suiteId: string;
    enabled: boolean;
    intervalMinutes?: number;
  }) => Promise<unknown>;
  const [isSaving, setIsSaving] = useState(false);

  const enabled = schedule?.enabled === true;
  const persistedIntervalMinutes = schedule?.intervalMinutes ?? 60;
  // Local draft so an interval picked while the schedule is OFF survives
  // until the next enable (the server only stores intervals on enabled
  // writes). Re-seeds when the persisted value changes from elsewhere.
  const [draftIntervalMinutes, setDraftIntervalMinutes] = useState(
    persistedIntervalMinutes,
  );
  useEffect(() => {
    setDraftIntervalMinutes(persistedIntervalMinutes);
  }, [persistedIntervalMinutes]);
  const pausedState =
    enabled && schedule && schedule.state !== "active"
      ? schedule.state
      : null;

  const apply = async (args: { enabled: boolean; intervalMinutes?: number }) => {
    setIsSaving(true);
    try {
      await setSuiteSchedule({ suiteId, ...args });
      toast.success(
        args.enabled ? "Schedule updated" : "Schedule disabled",
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to update schedule",
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Switch
            checked={enabled}
            disabled={isSaving}
            onCheckedChange={(checked) =>
              void apply({
                enabled: checked,
                intervalMinutes: draftIntervalMinutes,
              })
            }
            aria-label="Enable scheduled runs"
          />
          <span className="text-xs text-muted-foreground">
            {enabled ? "Scheduled runs on" : "Scheduled runs off"}
          </span>
        </div>
        <Select
          value={String(draftIntervalMinutes)}
          disabled={isSaving}
          onValueChange={(next) => {
            const minutes = Number(next);
            if (!Number.isFinite(minutes)) return;
            setDraftIntervalMinutes(minutes);
            // Enabled schedules persist immediately; while off, the draft
            // rides along on the next enable.
            if (enabled) {
              void apply({ enabled: true, intervalMinutes: minutes });
            }
          }}
        >
          <SelectTrigger className="h-8 w-44 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {INTERVAL_OPTIONS.map((option) => (
              <SelectItem
                key={option.minutes}
                value={String(option.minutes)}
                className="text-xs"
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {pausedState ? (
        <div className="flex items-start justify-between gap-3 rounded-md border border-warning/50 bg-warning/10 p-3">
          <p className="text-xs text-foreground">{PAUSE_COPY[pausedState]}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 shrink-0 text-xs"
            disabled={isSaving}
            onClick={() =>
              void apply({
                enabled: true,
                intervalMinutes: draftIntervalMinutes,
              })
            }
          >
            Resume
          </Button>
        </div>
      ) : null}
      <p className="text-[11px] text-muted-foreground">
        Runs the whole suite — render checks and prompt tests — under your
        identity. Prompt tests use the organization&apos;s model
        configuration; failed scheduled runs raise an in-app notification.
      </p>
    </div>
  );
}
