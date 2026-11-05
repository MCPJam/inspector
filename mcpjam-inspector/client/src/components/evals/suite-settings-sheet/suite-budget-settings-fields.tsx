import type { ReactNode } from "react";
import { Input } from "@mcpjam/design-system/input";
import { EXECUTION_BUDGET_DEFAULTS } from "@mcpjam/sdk/contract";
import type { EvalSuiteSettingKey } from "@/shared/eval-suite-settings-manifest";
import {
  EXECUTION_BUDGET_DRAFT_BOUNDS,
  type ExecutionBudgetBounds,
} from "../suite-settings-draft";
import { SuiteSettingsRow } from "../suite-settings-row";
import { LedgerRowChips } from "./suite-settings-ledger";
import type { SuiteSettingsEditor } from "./use-suite-settings-editor";

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
 * refuse-don't-clamp rule the resolver follows. Pre-empting it here would need
 * the effective ceiling, which suite capabilities do not carry yet.
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

/** The suite's execution budgets: four clocks and the model retry count. */
export function SuiteBudgetSettingsFields({
  editor,
}: {
  editor: SuiteSettingsEditor;
}) {
  const { draft, dispatchDraft, rowIsDirty, rowIsConflict } = editor;
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
          dispatchDraft({
            type: "edit",
            key: "turnTimeoutMs",
            value: next,
          })
        }
        accessory={
          <LedgerRowChips
            dirty={rowIsDirty("turnTimeoutMs")}
            conflict={rowIsConflict("turnTimeoutMs")}
          />
        }
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
          dispatchDraft({
            type: "edit",
            key: "toolCallTimeoutMs",
            value: next,
          })
        }
        accessory={
          <LedgerRowChips
            dirty={rowIsDirty("toolCallTimeoutMs")}
            conflict={rowIsConflict("toolCallTimeoutMs")}
          />
        }
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
        accessory={
          <LedgerRowChips
            dirty={rowIsDirty("iterationTimeoutMs")}
            conflict={rowIsConflict("iterationTimeoutMs")}
          />
        }
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
          dispatchDraft({
            type: "edit",
            key: "runTimeoutMs",
            value: next,
          })
        }
        accessory={
          <LedgerRowChips
            dirty={rowIsDirty("runTimeoutMs")}
            conflict={rowIsConflict("runTimeoutMs")}
          />
        }
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
          dispatchDraft({
            type: "edit",
            key: "turnRetries",
            value: next,
          })
        }
        accessory={
          <LedgerRowChips
            dirty={rowIsDirty("turnRetries")}
            conflict={rowIsConflict("turnRetries")}
          />
        }
      />
    </>
  );
}
