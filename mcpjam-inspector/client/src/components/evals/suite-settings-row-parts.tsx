import { useContext, type ReactNode } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { EXECUTION_BUDGET_DEFAULTS } from "@mcpjam/sdk/contract";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import type { EvalSuiteSettingKey } from "@/shared/eval-suite-settings-manifest";
import { CI_OWNED_REASON_COPY } from "./capability-reasons";
import {
  EXECUTION_BUDGET_DRAFT_BOUNDS,
  type ExecutionBudgetBounds,
} from "./suite-settings-draft";
import { SuiteSettingsRow } from "./suite-settings-row";
import { SuiteSettingsCompactContext } from "./suite-settings-compact";
import type { SuiteSettingsSheet } from "./use-suite-settings-sheet";

/**
 * One authored execution-budget clock.
 *
 * Authored in the unit a person thinks in and stored in milliseconds, because
 * "6" is what someone types and `360000` is what the runner spends. An EMPTY
 * input is not zero — it is un-authored, and the placeholder shows the platform
 * default the run will inherit instead, so "no value" reads as inheritance
 * rather than as something missing.
 *
 * `max` is the PLATFORM ceiling. An organization that lowered its own ceiling
 * is enforced by the server, which refuses the save with
 * EXECUTION_BUDGET_EXCEEDS_CEILING naming the field and the bound — the same
 * refuse-don't-clamp rule the resolver follows.
 */
function BudgetSettingRow({
  settingKey,
  label,
  hint,
  unit,
  unitMs,
  bounds,
  defaultMs,
  value,
  onChange,
  accessory,
}: {
  settingKey: EvalSuiteSettingKey;
  label: string;
  hint: string;
  unit: string;
  /** Milliseconds in one unit; 1 for a plain count like retries. */
  unitMs: number;
  /** Both platform bounds, so the control cannot offer what the save refuses. */
  bounds: ExecutionBudgetBounds;
  defaultMs: number;
  value: number | undefined;
  onChange: (next: number | undefined) => void;
  accessory?: ReactNode;
}) {
  const toUnit = (ms: number) => ms / unitMs;
  return (
    <SuiteSettingsRow
      settingKey={settingKey}
      chained={false}
      data-subsection-id={settingKey}
      accessory={accessory}
      hint={hint}
    >
      <div className="flex items-center gap-2">
        <Input
          type="number"
          className="w-28"
          aria-label={label}
          min={toUnit(bounds.min)}
          max={toUnit(bounds.max)}
          // The stored unit is milliseconds; minutes and seconds are only how
          // the number is shown. Without this the browser steps by 1 FROM the
          // floor, so a 10s floor on a minutes field makes every whole minute
          // a step mismatch — and a legal 45s could never be typed anyway.
          step="any"
          placeholder={`${toUnit(defaultMs)}`}
          value={value === undefined ? "" : String(toUnit(value))}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
            const raw = event.target.value.trim();
            if (raw === "") {
              onChange(undefined);
              return;
            }
            const parsed = Number(raw);
            // Refuse to turn a half-typed or nonsense entry into a stored
            // number: leave the previous value alone rather than writing NaN.
            if (!Number.isFinite(parsed)) return;
            onChange(Math.round(parsed * unitMs));
          }}
        />
        <span className="text-muted-foreground text-xs">{unit}</span>
        {value === undefined ? (
          <span className="text-muted-foreground text-xs">
            inheriting the platform default
          </span>
        ) : null}
      </div>
    </SuiteSettingsRow>
  );
}

export function LedgerRowChips({
  dirty,
  conflict,
}: {
  dirty: boolean;
  conflict: boolean;
}) {
  if (!dirty && !conflict) return null;
  return (
    <>
      {dirty ? (
        <span className="rounded-md border border-border px-1.5 py-px text-[11px] text-muted-foreground">
          Unsaved
        </span>
      ) : null}
      {conflict ? (
        <span className="rounded-md border border-warning/40 px-1.5 py-px text-[11px] text-warning-foreground">
          Changed elsewhere
        </span>
      ) : null}
    </>
  );
}

/**
 * Why the settings below cannot be changed here, and the way forward.
 *
 * At the TOP of the sheet, not on the control that refuses: someone opens
 * Settings to change something specific, and a reason discoverable only by
 * clicking the thing that does not work is a reason most people never read.
 */
function SuiteCiOwnedNotice({ onDuplicate }: { onDuplicate?: () => void }) {
  return (
    <div
      data-testid="suite-settings-ci-owned"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/40 px-4 py-3"
    >
      <p className="text-xs text-muted-foreground">{CI_OWNED_REASON_COPY}</p>
      {onDuplicate ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 shrink-0"
          onClick={onDuplicate}
          data-testid="suite-settings-duplicate-to-edit"
        >
          Duplicate to edit
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The CI-owned notice and the one `fieldset[disabled]` every settings control
 * sits inside, so a locked suite's sheet is a viewer rather than thirty
 * separately disabled controls.
 */
export function SuiteSettingsLockFrame({
  sheet,
  onDuplicateSuite,
  children,
}: {
  sheet: Pick<SuiteSettingsSheet, "configLocked" | "editingDisabled">;
  onDuplicateSuite?: () => void;
  children: ReactNode;
}) {
  // Compact rows carry their own padding and dividers.
  const compact = useContext(SuiteSettingsCompactContext);
  return (
    <>
      {sheet.configLocked ? (
        <SuiteCiOwnedNotice onDuplicate={onDuplicateSuite} />
      ) : null}
      <fieldset
        disabled={sheet.editingDisabled}
        className={
          compact
            ? "m-0 min-w-0 border-0 p-0"
            : "m-0 min-w-0 space-y-8 border-0 p-0"
        }
        data-testid={
          sheet.editingDisabled ? "suite-settings-locked" : undefined
        }
      >
        {children}
      </fieldset>
    </>
  );
}

/** The execution-budget clocks and the retry count, one row each. */
export function SuiteBudgetSettingsRows({
  sheet,
}: {
  sheet: SuiteSettingsSheet;
}) {
  const { draft, dispatchDraft, rowIsDirty, rowIsConflict } = sheet;
  const chips = (key: EvalSuiteSettingKey) => (
    <LedgerRowChips dirty={rowIsDirty(key)} conflict={rowIsConflict(key)} />
  );
  return (
    <>
      <BudgetSettingRow
        settingKey="turnTimeoutMs"
        label="Per-turn timeout"
        hint="How long one assistant turn may take, including the tool steps it drives."
        unit="minutes"
        unitMs={60_000}
        bounds={EXECUTION_BUDGET_DRAFT_BOUNDS.turnTimeoutMs}
        defaultMs={EXECUTION_BUDGET_DEFAULTS.evals.turnTimeoutMs}
        value={draft.current.turnTimeoutMs}
        onChange={(next) =>
          dispatchDraft({ type: "edit", key: "turnTimeoutMs", value: next })
        }
        accessory={chips("turnTimeoutMs")}
      />
      <BudgetSettingRow
        settingKey="toolCallTimeoutMs"
        label="Per-tool-call timeout"
        hint="How long one MCP request may take. A host-pinned per-server override still wins over this."
        unit="seconds"
        unitMs={1_000}
        bounds={EXECUTION_BUDGET_DRAFT_BOUNDS.toolCallTimeoutMs}
        defaultMs={EXECUTION_BUDGET_DEFAULTS.evals.toolCallTimeoutMs}
        value={draft.current.toolCallTimeoutMs}
        onChange={(next) =>
          dispatchDraft({ type: "edit", key: "toolCallTimeoutMs", value: next })
        }
        accessory={chips("toolCallTimeoutMs")}
      />
      <BudgetSettingRow
        settingKey="iterationTimeoutMs"
        label="Per-iteration timeout"
        hint="How long one trial may take. A trial that runs out of clock fails alone; its siblings keep going."
        unit="minutes"
        unitMs={60_000}
        bounds={EXECUTION_BUDGET_DRAFT_BOUNDS.iterationTimeoutMs}
        defaultMs={EXECUTION_BUDGET_DEFAULTS.evals.unitTimeoutMs}
        value={draft.current.iterationTimeoutMs}
        onChange={(next) =>
          dispatchDraft({
            type: "edit",
            key: "iterationTimeoutMs",
            value: next,
          })
        }
        accessory={chips("iterationTimeoutMs")}
      />
      <BudgetSettingRow
        settingKey="runTimeoutMs"
        label="Whole-run timeout"
        hint="A backstop for the whole run, not the working bound: the per-iteration clock is what usually fires."
        unit="minutes"
        unitMs={60_000}
        bounds={EXECUTION_BUDGET_DRAFT_BOUNDS.runTimeoutMs}
        defaultMs={EXECUTION_BUDGET_DEFAULTS.evals.runTimeoutMs}
        value={draft.current.runTimeoutMs}
        onChange={(next) =>
          dispatchDraft({ type: "edit", key: "runTimeoutMs", value: next })
        }
        accessory={chips("runTimeoutMs")}
      />
      <BudgetSettingRow
        settingKey="turnRetries"
        label="Model call retries"
        hint="How many times one model call is retried. Never applied to a live stream."
        unit="retries"
        unitMs={1}
        bounds={EXECUTION_BUDGET_DRAFT_BOUNDS.turnRetries}
        defaultMs={EXECUTION_BUDGET_DEFAULTS.evals.turnRetries}
        value={draft.current.turnRetries}
        onChange={(next) =>
          dispatchDraft({ type: "edit", key: "turnRetries", value: next })
        }
        accessory={chips("turnRetries")}
      />
    </>
  );
}

/** The two "save right away" writers behind the Where it runs row. */
export function useSuiteAttachmentUpdaters(suiteId: string) {
  const updateSuite = useMutation("testSuites:updateTestSuite" as any);
  const handleUpdateHostAttachments = async (
    attachments: Array<{
      namedHostId: string;
      enabledOptionalServerIds: string[];
    }>,
  ) => {
    try {
      await updateSuite({
        suiteId: suiteId,
        hostAttachments: attachments,
      });
      toast.success(
        attachments.length === 0 ? "Clients cleared" : "Clients updated",
      );
    } catch (error) {
      toast.error(getBillingErrorMessage(error, "Failed to update clients"));
      console.error("Failed to update host attachments:", error);
      throw error;
    }
  };

  const handleServerAttachmentUpdate = async (serverAttachmentId: string) => {
    // Picker calls this synchronously inside onClick — don't rethrow,
    // or the unawaited promise becomes an unhandled rejection.
    try {
      await updateSuite({
        suiteId: suiteId,
        serverAttachmentId,
      });
      toast.success("Server group updated");
    } catch (error) {
      toast.error(
        getBillingErrorMessage(error, "Failed to update server group"),
      );
    }
  };
  return { handleUpdateHostAttachments, handleServerAttachmentUpdate };
}
