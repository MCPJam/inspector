import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { toast } from "@/lib/toast";
import {
  type ChatboxSettings,
  type GuestExecutionSettings,
  useChatboxMutations,
} from "@/hooks/useChatboxes";
import { cn } from "@/lib/utils";
import { Button } from "@mcpjam/design-system/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
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
    // Nullish (not truthy) so a backend-set 0 renders as $0 rather than
    // silently falling back to the recommendation.
    dailyHarnessSpendUsd:
      ge?.dailyHarnessSpendCapMicros != null
        ? ge.dailyHarnessSpendCapMicros / MICROS_PER_USD
        : RECOMMENDED.dailyHarnessSpendUsd,
    dailyHarnessCallCap:
      ge?.dailyHarnessCallCap ?? RECOMMENDED.dailyHarnessCallCap,
    maxConcurrentHarnessRuns:
      ge?.maxConcurrentHarnessRuns ?? RECOMMENDED.maxConcurrentHarnessRuns,
  };
}

/** Mirror of backend validation; returns a human error or null. */
function formsEqual(a: FormState, b: FormState): boolean {
  return (
    a.enabled === b.enabled &&
    a.computerEnabled === b.computerEnabled &&
    a.sharedSkillsEnabled === b.sharedSkillsEnabled &&
    a.dailyCreditCap === b.dailyCreditCap &&
    a.dailyComputerStartCap === b.dailyComputerStartCap &&
    a.maxConcurrentComputers === b.maxConcurrentComputers &&
    a.harnessEnabled === b.harnessEnabled &&
    a.dailyHarnessSpendUsd === b.dailyHarnessSpendUsd &&
    a.dailyHarnessCallCap === b.dailyHarnessCallCap &&
    a.maxConcurrentHarnessRuns === b.maxConcurrentHarnessRuns
  );
}

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
    // Reset on chatbox switch too — two swarms can both have null/identical
    // guestExecution, so keying only on the value would keep the prior draft.
    setForm(fromSettings(chatbox.guestExecution));
  }, [chatbox.chatboxId, chatbox.guestExecution]);

  const savedForm = useMemo(
    () => fromSettings(chatbox.guestExecution),
    [chatbox.guestExecution],
  );
  const error = useMemo(() => validate(form), [form]);
  const isDirty = useMemo(
    () => !formsEqual(form, savedForm),
    [form, savedForm],
  );
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  // Cascade dependents off with their parent so the form can never sit in an
  // unsavable state (e.g. computerEnabled checked while enabled is off) and the
  // disabled controls stay visually aligned.
  const setEnabled = (v: boolean) =>
    setForm((prev) =>
      v
        ? { ...prev, enabled: true }
        : {
            ...prev,
            enabled: false,
            computerEnabled: false,
            sharedSkillsEnabled: false,
            harnessEnabled: false,
          },
    );
  const setComputerEnabled = (v: boolean) =>
    setForm((prev) =>
      v
        ? { ...prev, computerEnabled: true }
        : { ...prev, computerEnabled: false, harnessEnabled: false },
    );

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
      const guestExecution: GuestExecutionSettings = {
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
      };
      await setChatboxGuestExecution({
        chatboxId: chatbox.chatboxId,
        guestExecution,
      });
      toast.success("Guest execution settings saved");
      // Reflect the SAVED config to the parent (the mutation returns only a
      // status), so the share UI doesn't keep rendering the pre-save state.
      onUpdated?.({ ...chatbox, guestExecution });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to save guest execution",
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <Label htmlFor="ge-enabled" className="text-sm font-medium">
            Guest execution
          </Label>
          <p className="text-xs text-muted-foreground">
            Host-funded tools for link guests
          </p>
        </div>
        <Switch
          id="ge-enabled"
          checked={form.enabled}
          onCheckedChange={setEnabled}
        />
      </div>

      {!form.enabled ? (
        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground [&[data-state=open]>svg]:rotate-180">
            <ChevronDown className="size-3.5 shrink-0 transition-transform" />
            About guest execution
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-1.5">
            <p className="text-xs leading-relaxed text-muted-foreground">
              Let share-link guests run host tools on your organization&apos;s
              credits. Everything is off by default and capped per day.
            </p>
          </CollapsibleContent>
        </Collapsible>
      ) : null}

      {form.enabled ? (
        <div className="space-y-2 border-l border-border pl-3">
          <ToggleRow
            id="ge-computer"
            label="Guest computer"
            checked={form.computerEnabled}
            onCheckedChange={setComputerEnabled}
          />

          <ToggleRow
            id="ge-skills"
            label="Shared project skills"
            checked={form.sharedSkillsEnabled}
            onCheckedChange={(v) => set("sharedSkillsEnabled", v)}
          />

          {form.computerEnabled ? (
            <div className="space-y-2 pt-1">
              <ToggleRow
                id="ge-harness"
                label="Claude Code harness"
                checked={form.harnessEnabled}
                onCheckedChange={(v) => set("harnessEnabled", v)}
              />

              {form.harnessEnabled ? (
                <div className="space-y-2 pl-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">Daily caps</p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={applyRecommended}
                    >
                      Use recommended
                    </Button>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <NumberField
                      id="ge-harness-spend"
                      label="Spend (USD)"
                      min={1}
                      max={MAX_DAILY_HARNESS_SPEND_MICROS / MICROS_PER_USD}
                      value={form.dailyHarnessSpendUsd}
                      onChange={(n) => set("dailyHarnessSpendUsd", n)}
                    />
                    <NumberField
                      id="ge-harness-calls"
                      label="Calls"
                      min={1}
                      max={MAX_DAILY_HARNESS_CALLS}
                      value={form.dailyHarnessCallCap}
                      onChange={(n) => set("dailyHarnessCallCap", n)}
                    />
                    <NumberField
                      id="ge-harness-concurrency"
                      label="Concurrent"
                      min={1}
                      max={MAX_CONCURRENT_HARNESS_RUNS}
                      value={form.maxConcurrentHarnessRuns}
                      onChange={(n) => set("maxConcurrentHarnessRuns", n)}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      {isDirty ? (
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            onClick={() => void handleSave()}
            disabled={!!error || isSaving}
          >
            {isSaving ? "Saving..." : "Save changes"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ToggleRow({
  id,
  label,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <Label
        htmlFor={id}
        className={cn(
          "text-sm font-normal",
          disabled && "text-muted-foreground",
        )}
      >
        {label}
      </Label>
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
