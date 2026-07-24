/**
 * Suite schedule editor (synthetic monitors) — rendered as a section of the
 * suite settings sheet, behind the `synthetic-monitors` PostHog flag.
 *
 * Scheduled runs execute the WHOLE suite on a fixed interval under the
 * enabling user's identity (org-scoped delegated token; LLM cases bill the
 * organization's model config). Pause states surface here with a one-click
 * resume; resume resets the failure counter and the clock.
 */

import { useEffect, useMemo, useState } from "react";
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
import { useProjectEnvironments } from "@/hooks/useProjectEnvironments";
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";

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
  /**
   * The pinned project environment scheduled runs launch with. Required by
   * `setSuiteSchedule` when the suite attaches ≥2 environments; single-env
   * suites may omit it (the run-start default applies).
   */
  environmentId?: string;
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
  projectId = null,
  environmentIds,
}: {
  suiteId: string;
  schedule: SuiteSchedule | undefined;
  /** Needed only to label the environment pin (multi-env suites). */
  projectId?: string | null;
  /** The suite's attach-ordered project environments (absent ⇒ legacy). */
  environmentIds?: string[];
}) {
  const setSuiteSchedule = useMutation(
    "testSuites:setSuiteSchedule" as any
  ) as unknown as (args: {
    suiteId: string;
    enabled: boolean;
    intervalMinutes?: number;
    environmentId?: string;
  }) => Promise<unknown>;
  const [isSaving, setIsSaving] = useState(false);

  const enabled = schedule?.enabled === true;
  const persistedIntervalMinutes = schedule?.intervalMinutes ?? 60;
  // Local draft so an interval picked while the schedule is OFF survives
  // until the next enable (the server only stores intervals on enabled
  // writes). Re-seeds when the persisted value changes from elsewhere.
  const [draftIntervalMinutes, setDraftIntervalMinutes] = useState(
    persistedIntervalMinutes
  );
  useEffect(() => {
    setDraftIntervalMinutes(persistedIntervalMinutes);
  }, [persistedIntervalMinutes]);

  // Environment pin: REQUIRED when the suite attaches ≥2 environments.
  // Draft mirrors the interval pattern — persisted pin (or first attached
  // env) seeds it, and every enabled write carries it.
  // Memoized on CONTENT, not on the array reference: `environmentIds` comes
  // from a live Convex subscription and is a fresh array on every parent
  // re-render even when the ids are identical. Keying on the reference made the
  // seeding effect below re-run on any unrelated suite update, silently
  // discarding a pin the user had picked but not yet saved. Convex ids never
  // contain a comma, so the joined key is unambiguous.
  const attachedEnvironmentIdsKey = (environmentIds ?? []).join(",");
  const attachedEnvironmentIds = useMemo(
    () =>
      attachedEnvironmentIdsKey ? attachedEnvironmentIdsKey.split(",") : [],
    [attachedEnvironmentIdsKey]
  );
  // Flag-gated: with the kill-switch off, the environment pin control, its
  // query, and its write are all suppressed even for a suite that already has
  // ≥2 attached environments.
  const projectEnvironmentsEnabled = useProjectEnvironmentsEnabled();
  const requiresEnvironmentPin =
    projectEnvironmentsEnabled && attachedEnvironmentIds.length >= 2;
  const persistedEnvironmentId = schedule?.environmentId;
  const [draftEnvironmentId, setDraftEnvironmentId] = useState<
    string | undefined
  >(persistedEnvironmentId ?? attachedEnvironmentIds[0]);
  useEffect(() => {
    setDraftEnvironmentId(persistedEnvironmentId ?? attachedEnvironmentIds[0]);
  }, [persistedEnvironmentId, attachedEnvironmentIds]);
  const environments = useProjectEnvironments(
    requiresEnvironmentPin ? projectId : null
  );
  // Defensive: a persisted pin whose environment was detached from the
  // suite still renders (marked) so the user sees why a re-pin is needed.
  const pinDetached =
    !!draftEnvironmentId &&
    attachedEnvironmentIds.length > 0 &&
    !attachedEnvironmentIds.includes(draftEnvironmentId);

  const environmentLabel = (id: string) =>
    environments?.find((e) => e.environmentId === id)?.name ?? id;

  const apply = async (args: {
    enabled: boolean;
    intervalMinutes?: number;
    /** New pin to persist this write (env-change path); defaults to the draft
     * pin. Passed explicitly because a just-set draft isn't visible yet. */
    environmentId?: string;
  }) => {
    const effectiveEnvironmentId = args.environmentId ?? draftEnvironmentId;
    if (args.enabled && requiresEnvironmentPin && !effectiveEnvironmentId) {
      toast.error(
        "Pick which environment scheduled runs should use before enabling."
      );
      return;
    }
    setIsSaving(true);
    try {
      await setSuiteSchedule({
        suiteId,
        enabled: args.enabled,
        ...(args.intervalMinutes !== undefined
          ? { intervalMinutes: args.intervalMinutes }
          : {}),
        // Every enabled write carries the pin so a backend-side default can
        // never drift from what this editor shows.
        ...(args.enabled && requiresEnvironmentPin && effectiveEnvironmentId
          ? { environmentId: effectiveEnvironmentId }
          : {}),
      });
      toast.success(args.enabled ? "Schedule updated" : "Schedule disabled");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to update schedule"
      );
    } finally {
      setIsSaving(false);
    }
  };

  const pausedState =
    enabled && schedule && schedule.state !== "active" ? schedule.state : null;

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
      {requiresEnvironmentPin ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            Scheduled runs use environment
          </span>
          <Select
            value={draftEnvironmentId ?? ""}
            disabled={isSaving}
            onValueChange={(next) => {
              if (!next) return;
              setDraftEnvironmentId(next);
              // Route through apply() so this write serializes on `isSaving`
              // with the switch/interval writes — a quick disable or interval
              // change can no longer race and persist an unintended state.
              if (enabled) {
                void apply({
                  enabled: true,
                  intervalMinutes: draftIntervalMinutes,
                  environmentId: next,
                });
              }
            }}
          >
            <SelectTrigger className="h-8 w-44 text-xs">
              <SelectValue placeholder="Pick an environment" />
            </SelectTrigger>
            <SelectContent>
              {attachedEnvironmentIds.map((id) => (
                <SelectItem key={id} value={id} className="text-xs">
                  {environmentLabel(id)}
                </SelectItem>
              ))}
              {pinDetached && draftEnvironmentId ? (
                <SelectItem value={draftEnvironmentId} className="text-xs">
                  {environmentLabel(draftEnvironmentId)} (no longer attached)
                </SelectItem>
              ) : null}
            </SelectContent>
          </Select>
        </div>
      ) : null}
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
        identity. Prompt tests use the organization&apos;s model configuration;
        failed scheduled runs raise an in-app notification.
      </p>
    </div>
  );
}
