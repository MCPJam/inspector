/**
 * Stored quality-gate conditions under the Quality gate / policy subsection.
 *
 * Config only: these rows say what a future run must meet, never what a
 * past run scored. Comparative conditions need a complete baseline;
 * "Any gating evaluator errored" does not. Clearing the baseline selector
 * also clears the comparative fields so the review diff can name them.
 */

import { useEffect, useId, useRef, useState } from "react";
import { Switch } from "@mcpjam/design-system/switch";
import type { SuiteGatePolicyV1 } from "@mcpjam/sdk/contract";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import {
  DEPLOYMENT_REASON_COPY,
  PERMISSION_REASON_COPY,
} from "./capability-reasons";
import { PercentInput } from "./suite-policy-controls";
import { normalizeDraftGatePolicy } from "./suite-settings-draft";

export const QUALITY_GATE_BASELINE_HINT =
  "Comparison conditions use this baseline. The run's own verdict is unchanged.";

export const QUALITY_GATE_ALLOWED_DROP_HINT =
  "Maximum decrease in a gating evaluator's pass rate, in percentage points.";

export const QUALITY_GATE_ROLE_LEGEND =
  "Gate, Warn, and Report describe how an evaluator is configured, not a run result.";

export const QUALITY_GATE_CLI_ENFORCEMENT =
  "Applied by mcpjam cloud eval gate.";

export const QUALITY_GATE_GITHUB_ENFORCEMENT =
  "Applied by mcpjam cloud eval gate and GitHub checks.";

export const QUALITY_GATE_REASON_HINT =
  "A reason is required for quality-gate changes and will appear in revision history.";

type BaselineChoice = "none" | "run" | "commit_sha" | "previous_completed";

function hasCompleteBaseline(policy: SuiteGatePolicyV1 | undefined): boolean {
  const baseline = policy?.baseline;
  if (!baseline) return false;
  if (baseline.kind === "run") return baseline.runId.trim().length > 0;
  if (baseline.kind === "commit_sha") {
    return baseline.commitSha.trim().length > 0;
  }
  return baseline.kind === "previous_completed";
}

function qualityGateDisabledReason(
  capabilities: SuiteCapabilities | null | undefined,
  capabilitiesState: "loading" | "ready" | "unavailable",
): { copy: string; stamp: boolean } | undefined {
  if (capabilitiesState !== "ready") {
    // Degrade without stamping: the sheet's pre-capabilities ratchet
    // treats an absent backend as "we could not ask", not a refusal.
    return { copy: DEPLOYMENT_REASON_COPY, stamp: false };
  }
  if (!capabilities?.qualityGate?.evaluator) {
    return { copy: DEPLOYMENT_REASON_COPY, stamp: true };
  }
  if (capabilities.permissions["baseline.set"] !== true) {
    return { copy: PERMISSION_REASON_COPY, stamp: true };
  }
  return undefined;
}

function enforcementCopy(
  capabilities: SuiteCapabilities | null | undefined,
): string {
  return capabilities?.qualityGate?.githubEnforcement === true
    ? QUALITY_GATE_GITHUB_ENFORCEMENT
    : QUALITY_GATE_CLI_ENFORCEMENT;
}

function GateRow({
  settingKey,
  label,
  hint,
  children,
}: {
  settingKey: string;
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-setting-key={settingKey}
      className="flex items-start justify-between gap-4"
    >
      <div className="min-w-0 space-y-1">
        <p className="text-xs text-foreground">{label}</p>
        <p className="text-[11px] text-muted-foreground/60">{hint}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function MillisecondsInput({
  value,
  onCommit,
  ariaLabel,
  disabled,
}: {
  value: number | undefined;
  onCommit: (ms: number | undefined) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  const shown = value === undefined ? "" : String(value);
  const [text, setText] = useState(shown);
  const [editing, setEditing] = useState(false);
  // Escape reverts, and it does so by blurring — `blur()` runs the blur
  // handler synchronously against the text that was on screen, so the
  // handler has to be told the blur is a revert before it reads anything.
  // Same hazard, same shape as `PercentInput`.
  const revertOnBlur = useRef(false);
  useEffect(() => {
    if (!editing) setText(shown);
  }, [shown, editing]);

  const commit = () => {
    setEditing(false);
    if (revertOnBlur.current) {
      revertOnBlur.current = false;
      setText(shown);
      return;
    }
    const trimmed = text.trim();
    if (trimmed === "") {
      if (value !== undefined) onCommit(undefined);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setText(shown);
      return;
    }
    if (parsed === value) {
      setText(shown);
      return;
    }
    onCommit(parsed);
  };

  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <input
        className="h-8 w-20 rounded-md border border-input bg-background px-2 text-right text-xs text-foreground"
        value={text}
        inputMode="numeric"
        disabled={disabled}
        aria-label={ariaLabel}
        onFocus={() => setEditing(true)}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            revertOnBlur.current = true;
            setText(shown);
            event.currentTarget.blur();
          }
        }}
      />
      <span aria-hidden>ms</span>
    </span>
  );
}

export function SuiteQualityGateSection({
  policy,
  onChange,
  capabilities,
  capabilitiesState,
  simplified = false,
}: {
  policy: SuiteGatePolicyV1 | undefined;
  onChange: (next: SuiteGatePolicyV1 | undefined) => void;
  capabilities?: SuiteCapabilities | null;
  capabilitiesState: "loading" | "ready" | "unavailable";
  /** Settings only exposes baseline comparison; retain other stored policy fields. */
  simplified?: boolean;
}) {
  const baselineId = useId();
  const runIdInputId = useId();
  const commitInputId = useId();
  const disabledReason = qualityGateDisabledReason(
    capabilities,
    capabilitiesState,
  );
  const disabled = disabledReason !== undefined;
  const allowPrevious = capabilities?.qualityGate?.previousRunBaseline === true;
  const comparativeEnabled = !disabled && hasCompleteBaseline(policy);
  // Conditions the simplified sheet does not show but "None" would clear.
  // Named next to the select so the discard is a choice, not a surprise.
  const hiddenComparativeConditions = simplified
    ? [
        policy?.maximumPassRateDrop != null ? "pass-rate drop" : null,
        policy?.noDeterministicRegressions ? "deterministic regressions" : null,
        policy?.maximumP95LatencyIncreaseMs != null
          ? "p95 latency increase"
          : null,
      ].filter((label): label is string => label !== null)
    : [];
  const [pendingKind, setPendingKind] = useState<"run" | "commit_sha" | null>(
    null,
  );
  const [runIdText, setRunIdText] = useState(
    policy?.baseline?.kind === "run" ? policy.baseline.runId : "",
  );
  const [commitText, setCommitText] = useState(
    policy?.baseline?.kind === "commit_sha" ? policy.baseline.commitSha : "",
  );

  useEffect(() => {
    if (policy?.baseline?.kind === "run") {
      setRunIdText(policy.baseline.runId);
      setPendingKind(null);
    } else if (policy?.baseline?.kind === "commit_sha") {
      setCommitText(policy.baseline.commitSha);
      setPendingKind(null);
    } else if (policy?.baseline === undefined && pendingKind === null) {
      setRunIdText("");
      setCommitText("");
    }
  }, [policy, pendingKind]);

  const choice: BaselineChoice =
    policy?.baseline?.kind ?? pendingKind ?? "none";

  const commitPolicy = (next: SuiteGatePolicyV1 | undefined) => {
    onChange(normalizeDraftGatePolicy(next));
  };

  /**
   * The policy MINUS its baseline, for a baseline that is being TYPED.
   *
   * An empty run-id or commit field is someone mid-edit, not someone
   * choosing None: the comparative conditions beside it are still what they
   * asked for, so `maximumPassRateDrop`, `noDeterministicRegressions` and
   * `maximumP95LatencyIncreaseMs` travel untouched. (Selecting None is the
   * deliberate case, and clears them — see `setBaselineChoice`.)
   */
  const withoutBaseline = (): SuiteGatePolicyV1 => {
    if (!policy) return {};
    const { baseline: _dropped, ...rest } = policy;
    return rest;
  };

  const setBaselineChoice = (next: BaselineChoice) => {
    if (next === "none") {
      setPendingKind(null);
      setRunIdText("");
      setCommitText("");
      // Choosing None is deliberate, and the three comparative conditions
      // cannot be evaluated without a baseline — storing them would publish a
      // permanently non-gateable check. Only the absolute condition survives.
      commitPolicy({
        noGatingScoreErrors: policy?.noGatingScoreErrors,
      });
      return;
    }
    if (next === "previous_completed") {
      setPendingKind(null);
      commitPolicy({
        ...policy,
        baseline: { kind: "previous_completed" },
      });
      return;
    }
    setPendingKind(next);
    if (next === "run") {
      setCommitText("");
      if (runIdText.trim()) {
        commitPolicy({
          ...policy,
          baseline: { kind: "run", runId: runIdText.trim() },
        });
      } else {
        commitPolicy(withoutBaseline());
      }
      return;
    }
    setRunIdText("");
    if (commitText.trim()) {
      commitPolicy({
        ...policy,
        baseline: { kind: "commit_sha", commitSha: commitText.trim() },
      });
    } else {
      commitPolicy(withoutBaseline());
    }
  };

  const baselineResolvedLabel = (() => {
    if (choice === "run") {
      const id =
        policy?.baseline?.kind === "run" ? policy.baseline.runId : runIdText;
      return id.trim() ? `Run ${id}` : "No run selected";
    }
    if (choice === "commit_sha") {
      const sha =
        policy?.baseline?.kind === "commit_sha"
          ? policy.baseline.commitSha
          : commitText;
      return sha.trim() ? `Commit ${sha}` : "No commit selected";
    }
    if (choice === "previous_completed") {
      return allowPrevious
        ? "Previous completed run"
        : "Previous run (not available on this deployment)";
    }
    return "None";
  })();

  /**
   * The conditions the simplified page does not edit, listed only when this
   * suite actually carries one. Absent means absent: an empty list renders
   * nothing rather than three rows of "off", which would read as a policy.
   */
  const storedAdvancedConditions: {
    key: string;
    label: string;
    value: string;
  }[] = [
    policy?.noDeterministicRegressions === true
      ? {
          key: "qualityGateNoDeterministicRegressions",
          label: "Deterministic regressions",
          value: "Fail",
        }
      : null,
    typeof policy?.maximumP95LatencyIncreaseMs === "number"
      ? {
          key: "qualityGateMaximumP95LatencyIncreaseMs",
          label: "p95 latency increase",
          value: `${policy.maximumP95LatencyIncreaseMs} ms`,
        }
      : null,
    policy?.noGatingScoreErrors === true
      ? {
          key: "qualityGateNoGatingScoreErrors",
          label: "Any gating evaluator errored",
          value: "Fail",
        }
      : null,
  ].filter((row): row is { key: string; label: string; value: string } =>
    Boolean(row),
  );

  const controls = (
    <div className="space-y-3">
      {!simplified && (
        <p className="text-[11px] text-muted-foreground/60">
          {QUALITY_GATE_ROLE_LEGEND}
        </p>
      )}
      {!simplified && (
        <p className="text-[11px] text-muted-foreground/60">
          {enforcementCopy(capabilities)}
        </p>
      )}

      <GateRow
        settingKey="qualityGateBaseline"
        label="Baseline"
        hint={QUALITY_GATE_BASELINE_HINT}
      >
        <div className={simplified ? "w-40 space-y-1" : "space-y-1"}>
          <select
            id={baselineId}
            className={`h-8 ${
              simplified ? "w-full" : ""
            } rounded-md border border-input bg-background px-2 text-xs text-foreground`}
            value={choice}
            disabled={disabled}
            aria-label="Quality gate baseline"
            onChange={(event) =>
              setBaselineChoice(event.target.value as BaselineChoice)
            }
          >
            <option value="none">None</option>
            <option value="run">A specific run</option>
            <option value="commit_sha">A specific commit</option>
            {allowPrevious ? (
              <option value="previous_completed">Previous run</option>
            ) : null}
          </select>
          <p className="break-all text-right text-[11px] text-muted-foreground/60">
            {baselineResolvedLabel}
          </p>
          {hiddenComparativeConditions.length > 0 && choice !== "none" ? (
            <p
              className="text-[11px] text-muted-foreground"
              data-testid="quality-gate-none-clears"
            >
              Choosing None also clears the{" "}
              {hiddenComparativeConditions.join(", ")} condition
              {hiddenComparativeConditions.length > 1 ? "s" : ""} set on this
              suite, which cannot run without a baseline.
            </p>
          ) : null}
        </div>
      </GateRow>

      {choice === "run" ? (
        <label
          className="flex items-center justify-end gap-2 text-xs text-muted-foreground"
          htmlFor={runIdInputId}
        >
          <span>Run id</span>
          <input
            id={runIdInputId}
            className={`h-8 ${
              simplified ? "w-40" : "w-48"
            } rounded-md border border-input bg-background px-2 text-xs text-foreground`}
            value={runIdText}
            disabled={disabled}
            aria-label="Baseline run id"
            placeholder="run_…"
            onChange={(event) => {
              const next = event.target.value;
              setRunIdText(next);
              if (next.trim()) {
                commitPolicy({
                  ...policy,
                  baseline: { kind: "run", runId: next.trim() },
                });
              } else {
                commitPolicy(withoutBaseline());
              }
            }}
          />
        </label>
      ) : null}

      {choice === "commit_sha" ? (
        <label
          className="flex items-center justify-end gap-2 text-xs text-muted-foreground"
          htmlFor={commitInputId}
        >
          <span>Commit</span>
          <input
            id={commitInputId}
            className={`h-8 ${
              simplified ? "w-40" : "w-48"
            } rounded-md border border-input bg-background px-2 font-mono text-xs text-foreground`}
            value={commitText}
            disabled={disabled}
            aria-label="Baseline commit SHA"
            placeholder="abcdef1"
            onChange={(event) => {
              const next = event.target.value;
              setCommitText(next);
              if (next.trim()) {
                commitPolicy({
                  ...policy,
                  baseline: { kind: "commit_sha", commitSha: next.trim() },
                });
              } else {
                commitPolicy(withoutBaseline());
              }
            }}
          />
        </label>
      ) : null}

      <GateRow
        settingKey="qualityGateAllowedDrop"
        label="Allowed drop"
        hint={QUALITY_GATE_ALLOWED_DROP_HINT}
      >
        <PercentInput
          aligned={simplified}
          value={policy?.maximumPassRateDrop}
          disabled={disabled || !comparativeEnabled}
          ariaLabel="Maximum gating evaluator pass-rate drop"
          onCommit={(fraction) =>
            commitPolicy({
              ...policy,
              maximumPassRateDrop: fraction,
            })
          }
        />
      </GateRow>

      {/*
        Under `simplified` these three are not editable here — but a policy set
        through CI is still THIS suite's policy, and a page that shows only the
        conditions it can edit reports a weaker gate than the one that runs.
        Each renders read-only when it carries a stored value, so the reader
        sees what will actually be enforced; the baseline warning above is what
        clears them.
      */}
      {simplified && storedAdvancedConditions.length > 0 && (
        <div className="space-y-1 border-t border-border/60 pt-3">
          <p className="text-[11px] text-muted-foreground/60">
            Also enforced, set outside this page:
          </p>
          <ul className="space-y-0.5">
            {storedAdvancedConditions.map((condition) => (
              <li
                key={condition.key}
                data-setting-key={condition.key}
                data-readonly="true"
                className="flex items-center justify-between gap-4 text-[11px] text-muted-foreground"
              >
                <span>{condition.label}</span>
                <span className="tabular-nums text-foreground">
                  {condition.value}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!simplified && (
        <>
          <GateRow
            settingKey="qualityGateNoDeterministicRegressions"
            label="Deterministic regressions"
            hint="Fail when a deterministic gating evaluator flips against the baseline."
          >
            <Switch
              checked={policy?.noDeterministicRegressions === true}
              disabled={disabled || !comparativeEnabled}
              aria-label="No deterministic regressions"
              onCheckedChange={(checked) =>
                commitPolicy({
                  ...policy,
                  noDeterministicRegressions:
                    checked === true ? true : undefined,
                })
              }
            />
          </GateRow>

          <GateRow
            settingKey="qualityGateMaximumP95LatencyIncreaseMs"
            label="p95 latency increase"
            hint="Maximum p95 end-to-end latency growth, in milliseconds."
          >
            <MillisecondsInput
              value={policy?.maximumP95LatencyIncreaseMs}
              disabled={disabled || !comparativeEnabled}
              ariaLabel="Maximum p95 latency increase in milliseconds"
              onCommit={(ms) =>
                commitPolicy({
                  ...policy,
                  maximumP95LatencyIncreaseMs: ms,
                })
              }
            />
          </GateRow>

          <GateRow
            settingKey="qualityGateNoGatingScoreErrors"
            label="Any gating evaluator errored"
            hint="Fails when a gating evaluator errors. Does not need a baseline."
          >
            <Switch
              checked={policy?.noGatingScoreErrors === true}
              disabled={disabled}
              aria-label="Any gating evaluator errored"
              onCheckedChange={(checked) =>
                commitPolicy({
                  ...policy,
                  noGatingScoreErrors: checked === true ? true : undefined,
                })
              }
            />
          </GateRow>
        </>
      )}
    </div>
  );

  return (
    <div data-testid="suite-quality-gate-section" className="space-y-3">
      {disabledReason ? (
        <p
          className="text-sm text-muted-foreground"
          {...(disabledReason.stamp
            ? { "data-disabled-reason": disabledReason.copy }
            : {})}
        >
          {disabledReason.copy}
        </p>
      ) : null}
      {disabled ? (
        <fieldset disabled className="contents">
          {controls}
        </fieldset>
      ) : (
        controls
      )}
    </div>
  );
}
