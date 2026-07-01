import { useEffect, useMemo, useState } from "react";
import { toast } from "@/lib/toast";
import {
  type ChatboxSettings,
  type GuestExecutionSettings,
  useChatboxMutations,
} from "@/hooks/useChatboxes";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { Switch } from "@mcpjam/design-system/switch";

/**
 * Secure Guest Harness Enablement — admin-only per-swarm guest-execution editor.
 *
 * Writes `chatboxes:setChatboxGuestExecution` (project-admin gated server-side).
 * Everything defaults OFF; harness requires guest execution + a host computer,
 * and its host-funded spend/call/concurrency caps are bounded by the same hard
 * ceilings the backend enforces (mirrored here for a friendly disabled-Save +
 * inline errors; the backend `validateGuestExecutionConfig` is authoritative).
 *
 * Only meaningful for `anyone_with_link` swarms (host-funded guest grants); the
 * parent renders it in the publish/share settings.
 */

// Hard ceilings — mirror backend `executionAccess.ts`.
const MAX_DAILY_HARNESS_SPEND_MICROS = 20_000_000; // $20/day
const MAX_DAILY_HARNESS_CALLS = 500;
const MAX_CONCURRENT_HARNESS_RUNS = 2;
const MICROS_PER_USD = 1_000_000;

// Recommended harness preset when first enabling.
const RECOMMENDED = {
  dailyHarnessSpendUsd: 5,
  dailyHarnessCallCap: 100,
  maxConcurrentHarnessRuns: 1,
};

interface FormState {
  enabled: boolean;
  computerEnabled: boolean;
  sharedSkillsEnabled: boolean;
  dailyCreditCap: number;
  dailyComputerStartCap: number;
  maxConcurrentComputers: number;
  harnessEnabled: boolean;
  /** Displayed to the admin in whole USD/day; converted to micros on save. */
  dailyHarnessSpendUsd: number;
  dailyHarnessCallCap: number;
  maxConcurrentHarnessRuns: number;
}

function fromSettings(
  ge: GuestExecutionSettings | null | undefined,
): FormState {
  return {
    enabled: ge?.enabled ?? false,
    computerEnabled: ge?.computerEnabled ?? false,
    sharedSkillsEnabled: ge?.sharedSkillsEnabled ?? false,
    // Computer caps carry a sensible non-zero default so enabling computers is
    // one toggle; they're only validated when computerEnabled.
    dailyCreditCap: ge?.dailyCreditCap ?? 500,
    dailyComputerStartCap: ge?.dailyComputerStartCap ?? 10,
    maxConcurrentComputers: ge?.maxConcurrentComputers ?? 2,
    harnessEnabled: ge?.harnessEnabled ?? false,
    dailyHarnessSpendUsd: ge?.dailyHarnessSpendCapMicros
      ? ge.dailyHarnessSpendCapMicros / MICROS_PER_USD
      : RECOMMENDED.dailyHarnessSpendUsd,
    dailyHarnessCallCap:
      ge?.dailyHarnessCallCap ?? RECOMMENDED.dailyHarnessCallCap,
    maxConcurrentHarnessRuns:
      ge?.maxConcurrentHarnessRuns ?? RECOMMENDED.maxConcurrentHarnessRuns,
  };
}

/** Mirror of backend validation; returns a human error or null. */
function validate(form: FormState): string | null {
  if (form.computerEnabled && !form.enabled) {
    return "Enable guest execution before enabling computers.";
  }
  if (form.harnessEnabled) {
    if (!form.enabled) return "Enable guest execution before the harness.";
    if (!form.computerEnabled) {
      return "Enable the guest computer before the harness (it runs inside it).";
    }
    if (!(form.dailyHarnessSpendUsd > 0)) {
      return "Daily harness spend must be greater than $0.";
    }
    if (
      form.dailyHarnessSpendUsd * MICROS_PER_USD >
      MAX_DAILY_HARNESS_SPEND_MICROS
    ) {
      return `Daily harness spend can't exceed $${
        MAX_DAILY_HARNESS_SPEND_MICROS / MICROS_PER_USD
      }.`;
    }
    if (
      !Number.isInteger(form.dailyHarnessCallCap) ||
      form.dailyHarnessCallCap <= 0
    ) {
      return "Daily harness calls must be a positive whole number.";
    }
    if (form.dailyHarnessCallCap > MAX_DAILY_HARNESS_CALLS) {
      return `Daily harness calls can't exceed ${MAX_DAILY_HARNESS_CALLS}.`;
    }
    if (
      !Number.isInteger(form.maxConcurrentHarnessRuns) ||
      form.maxConcurrentHarnessRuns <= 0
    ) {
      return "Concurrent harness runs must be a positive whole number.";
    }
    if (form.maxConcurrentHarnessRuns > MAX_CONCURRENT_HARNESS_RUNS) {
      return `Concurrent harness runs can't exceed ${MAX_CONCURRENT_HARNESS_RUNS}.`;
    }
  }
  return null;
}

interface Props {
  chatbox: ChatboxSettings;
  onUpdated?: (chatbox: ChatboxSettings) => void;
}

export function ChatboxGuestExecutionSection({ chatbox, onUpdated }: Props) {
  const { setChatboxGuestExecution } = useChatboxMutations();
  const [form, setForm] = useState<FormState>(() =>
    fromSettings(chatbox.guestExecution),
  );
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setForm(fromSettings(chatbox.guestExecution));
  }, [chatbox.guestExecution]);

  const error = useMemo(() => validate(form), [form]);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const applyRecommended = () =>
    setForm((prev) => ({
      ...prev,
      harnessEnabled: true,
      dailyHarnessSpendUsd: RECOMMENDED.dailyHarnessSpendUsd,
      dailyHarnessCallCap: RECOMMENDED.dailyHarnessCallCap,
      maxConcurrentHarnessRuns: RECOMMENDED.maxConcurrentHarnessRuns,
    }));

  const handleSave = async () => {
    if (error) return;
    setIsSaving(true);
    try {
      await setChatboxGuestExecution({
        chatboxId: chatbox.chatboxId,
        guestExecution: {
          enabled: form.enabled,
          computerEnabled: form.computerEnabled,
          sharedSkillsEnabled: form.sharedSkillsEnabled,
          dailyCreditCap: form.dailyCreditCap,
          dailyComputerStartCap: form.dailyComputerStartCap,
          maxConcurrentComputers: form.maxConcurrentComputers,
          harnessEnabled: form.harnessEnabled,
          // Only send harness caps when harness is on; the backend validates
          // them as a set and they're advisory when disabled.
          ...(form.harnessEnabled
            ? {
                dailyHarnessSpendCapMicros: Math.round(
                  form.dailyHarnessSpendUsd * MICROS_PER_USD,
                ),
                dailyHarnessCallCap: form.dailyHarnessCallCap,
                maxConcurrentHarnessRuns: form.maxConcurrentHarnessRuns,
              }
            : {}),
        },
      });
      toast.success("Guest execution settings saved");
      onUpdated?.(chatbox);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to save guest execution",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const guestLink = chatbox.allowGuestAccess;

  return (
    <div className="space-y-4 rounded-md border border-input p-4">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Guest execution (host-funded)</h3>
        <p className="text-xs text-muted-foreground">
          Let share-link guests run host tools on your organization's credits.
          Everything is off by default and capped per day. Only applies to
          "anyone with the link" swarms.
        </p>
        {!guestLink ? (
          <p className="text-xs text-amber-600 dark:text-amber-500">
            This swarm isn't shared with guests yet — set access to "anyone with
            the link" for guest execution to take effect.
          </p>
        ) : null}
      </div>

      <ToggleRow
        id="ge-enabled"
        label="Enable guest execution"
        description="Master switch for host-funded guest tools + skills."
        checked={form.enabled}
        onCheckedChange={(v) => set("enabled", v)}
      />

      <ToggleRow
        id="ge-computer"
        label="Guest computer"
        description="Provision a host-funded cloud computer for guests (bash + files)."
        checked={form.computerEnabled}
        disabled={!form.enabled}
        onCheckedChange={(v) => set("computerEnabled", v)}
      />

      <ToggleRow
        id="ge-skills"
        label="Shared project skills"
        description="Expose the project's shared (not personal) skills to guests."
        checked={form.sharedSkillsEnabled}
        disabled={!form.enabled}
        onCheckedChange={(v) => set("sharedSkillsEnabled", v)}
      />

      {/* Secure Guest Harness Enablement — the Claude Code harness sub-panel. */}
      <div className="space-y-3 rounded-md border border-dashed border-input p-3">
        <ToggleRow
          id="ge-harness"
          label="Claude Code harness"
          description="Run the real Claude Code agent for guests (claude-code hosts only). Requires the guest computer."
          checked={form.harnessEnabled}
          disabled={!form.enabled || !form.computerEnabled}
          onCheckedChange={(v) => set("harnessEnabled", v)}
        />

        {form.harnessEnabled ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Recommended starting caps: $5/day, 100 calls/day, 1 concurrent
                run.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={applyRecommended}
              >
                Use recommended
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <NumberField
                id="ge-harness-spend"
                label="Daily spend (USD)"
                min={1}
                max={MAX_DAILY_HARNESS_SPEND_MICROS / MICROS_PER_USD}
                value={form.dailyHarnessSpendUsd}
                onChange={(n) => set("dailyHarnessSpendUsd", n)}
              />
              <NumberField
                id="ge-harness-calls"
                label="Daily calls"
                min={1}
                max={MAX_DAILY_HARNESS_CALLS}
                value={form.dailyHarnessCallCap}
                onChange={(n) => set("dailyHarnessCallCap", n)}
              />
              <NumberField
                id="ge-harness-concurrency"
                label="Concurrent runs"
                min={1}
                max={MAX_CONCURRENT_HARNESS_RUNS}
                value={form.maxConcurrentHarnessRuns}
                onChange={(n) => set("maxConcurrentHarnessRuns", n)}
              />
            </div>
          </div>
        ) : null}
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <div className="flex justify-end">
        <Button
          type="button"
          onClick={() => void handleSave()}
          disabled={!!error || isSaving}
        >
          {isSaving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}

function ToggleRow({
  id,
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}

function NumberField({
  id,
  label,
  min,
  max,
  value,
  onChange,
}: {
  id: string;
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(Number.isFinite(n) ? n : 0);
        }}
      />
    </div>
  );
}
