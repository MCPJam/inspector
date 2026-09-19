/**
 * Stored quality-gate conditions under the Quality gate / policy subsection.
 *
 * Config only: these rows say what a future run must meet, never what a
 * past run scored.
 *
 * BASELINE COMPARISON IS NOT EDITED HERE. The baseline selector and the three
 * conditions that cannot be evaluated without one — allowed pass-rate drop,
 * deterministic regressions, p95 latency increase — were removed from the
 * page. The fields are unchanged on the API and still enforced by a run, so a
 * suite that carries one is listed read-only below rather than going unsaid.
 */

import { Switch } from "@mcpjam/design-system/switch";
import type { SuiteGatePolicyV1 } from "@mcpjam/sdk/contract";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import {
  DEPLOYMENT_REASON_COPY,
  PERMISSION_REASON_COPY,
} from "./capability-reasons";
import { normalizeDraftGatePolicy } from "./suite-settings-draft";

export const QUALITY_GATE_ROLE_LEGEND =
  "Required and Advisory describe how an evaluator is configured, not a run result.";

export const QUALITY_GATE_CLI_ENFORCEMENT =
  "Applied by mcpjam cloud eval gate.";

export const QUALITY_GATE_GITHUB_ENFORCEMENT =
  "Applied by mcpjam cloud eval gate and GitHub checks.";

export const QUALITY_GATE_REASON_HINT =
  "A reason is required for quality-gate changes and will appear in revision history.";

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

/** Whole-percentage-point rendering of a stored pass-rate drop fraction. */
function formatAllowedDrop(fraction: number): string {
  const points = fraction * 100;
  return `${Number.isInteger(points) ? points : Number(points.toFixed(2))} pp`;
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
  /** Settings drops the legend and enforcement copy; the rows are the same. */
  simplified?: boolean;
}) {
  const disabledReason = qualityGateDisabledReason(
    capabilities,
    capabilitiesState,
  );
  const disabled = disabledReason !== undefined;

  const commitPolicy = (next: SuiteGatePolicyV1 | undefined) => {
    onChange(normalizeDraftGatePolicy(next));
  };

  /**
   * The comparison conditions this page no longer edits, listed only when this
   * suite actually carries one. Absent means absent: an empty list renders
   * nothing rather than rows of "off", which would read as a policy.
   *
   * A policy set through CI is still THIS suite's policy, and a page that
   * shows only what it can edit reports a weaker gate than the one that runs.
   */
  const storedComparisonConditions: {
    key: string;
    label: string;
    value: string;
  }[] = [
    typeof policy?.maximumPassRateDrop === "number"
      ? {
          key: "qualityGateAllowedDrop",
          label: "Allowed drop",
          value: formatAllowedDrop(policy.maximumPassRateDrop),
        }
      : null,
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
        settingKey="qualityGateNoGatingScoreErrors"
        label="Any required evaluator errored"
        hint="Fails when a required evaluator errors."
      >
        <Switch
          checked={policy?.noGatingScoreErrors === true}
          disabled={disabled}
          aria-label="Any required evaluator errored"
          onCheckedChange={(checked) =>
            commitPolicy({
              ...policy,
              noGatingScoreErrors: checked === true ? true : undefined,
            })
          }
        />
      </GateRow>

      {storedComparisonConditions.length > 0 && (
        <div className="space-y-1 border-t border-border/60 pt-3">
          <p className="text-[11px] text-muted-foreground/60">
            Also enforced, set outside this page:
          </p>
          <ul className="space-y-0.5">
            {storedComparisonConditions.map((condition) => (
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
