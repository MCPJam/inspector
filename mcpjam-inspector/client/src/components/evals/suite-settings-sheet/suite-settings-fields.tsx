import {
  EVAL_GRADING_VALIDITY_HINTS,
  EVAL_GRADING_VALIDITY_LABELS,
  EVAL_ITERATION_RULE_HINTS,
  EVAL_ITERATION_RULE_LABELS,
  EVAL_PASS_CRITERION_SCOPE_HINTS,
  EVAL_PASS_CRITERION_SCOPE_LABELS,
} from "@mcpjam/sdk/contract";
import type { SuiteCapabilitiesState } from "@/hooks/use-suite-capabilities";
import { PassCriteriaSelector } from "../pass-criteria-selector";
import {
  PerCaseIterationsControl,
  PerCasePassThresholdControl,
  VerdictValidityControls,
} from "../suite-policy-controls";
import { SuiteQualityGateSection } from "../suite-quality-gate-section";
import { SuiteSettingsRow } from "../suite-settings-row";
import { LedgerRowChips } from "./suite-settings-ledger";
import type { SuiteSettingsEditor } from "./use-suite-settings-editor";

/**
 * What decides a run: the pass criterion, how many iterations, and the
 * quality gate against a baseline. Edits land in the shared settings draft.
 */
export function SuiteSettingsFields({
  editor,
  capabilities: capabilitiesResult,
}: {
  editor: SuiteSettingsEditor;
  capabilities: SuiteCapabilitiesState;
}) {
  const {
    draft,
    dispatchDraft,
    rowIsDirty,
    rowIsConflict,
    isVerdictPolicyV2,
    defaultMinimumPassRate,
  } = editor;
  const { state: capabilitiesState, capabilities } = capabilitiesResult;
  const capabilitiesReady = capabilitiesState === "ready" && capabilities;

  return (
    <>
      {/*
        THREE SECTIONS, in the order a reader asks the questions: what
        must pass, how many times, and does it regress against a
        baseline. They were one section titled "Quality gate" holding
        all three — so the criterion, the count and the gate shared one
        Edit affordance and one dirty badge, and somebody looking for
        the threshold their runs are decided against had to open a
        heading about regressions to find it.

        Within each section the SCOPE picks the control, and the scope's
        own words come from the shared grading vocabulary. No section
        offers a switch between the two: the criteria differ in scope as
        well as units, so converting one into the other re-decides every
        multi-case suite and is not an edit a threshold field can make.
      */}
      <SuiteSettingsRow
        settingKey="policy"
        className="pr-6"
        chained={false}
        data-subsection-id="policy"
        accessory={
          <LedgerRowChips
            dirty={rowIsDirty("policy")}
            conflict={rowIsConflict("policy")}
          />
        }
        hint={
          isVerdictPolicyV2
            ? EVAL_PASS_CRITERION_SCOPE_HINTS.perCase
            : EVAL_PASS_CRITERION_SCOPE_HINTS.suiteWide
        }
      >
        {isVerdictPolicyV2 ? (
          <PerCasePassThresholdControl
            aligned
            defaults={draft.current.verdictPolicyDefaults}
            onChange={(next) =>
              dispatchDraft({
                type: "edit",
                key: "verdictPolicyDefaults",
                value: next,
              })
            }
          />
        ) : (
          /* Stamped by hand, nested inside the criterion section: the
             suite-wide threshold stays reachable from the API on its
             own. The parity ratchet reads the attribute, not the
             component. */
          <div
            className="flex items-center justify-between gap-4"
            data-setting-key="minimumAccuracy"
          >
            <span className="text-xs text-muted-foreground">
              {EVAL_PASS_CRITERION_SCOPE_LABELS.suiteWide}
            </span>
            <PassCriteriaSelector
              aligned
              hideLabel
              minimumPassRate={defaultMinimumPassRate}
              onMinimumPassRateChange={(rate) =>
                dispatchDraft({
                  type: "edit",
                  key: "defaultPassCriteria",
                  value: { minimumPassRate: rate },
                })
              }
            />
          </div>
        )}
        {isVerdictPolicyV2 ? (
          <div data-setting-key="validity" className="space-y-2">
            <p className="text-xs font-medium text-foreground">
              {EVAL_GRADING_VALIDITY_LABELS.enforced}
            </p>
            <p className="text-[11px] text-muted-foreground/60">
              {EVAL_GRADING_VALIDITY_HINTS.enforced}
            </p>
            <VerdictValidityControls
              defaults={draft.current.verdictPolicyDefaults}
              onChange={(next) =>
                dispatchDraft({
                  type: "edit",
                  key: "verdictPolicyDefaults",
                  value: next,
                })
              }
            />
          </div>
        ) : (
          /* NOT an inactive control, and not a blank space: a
             suite-wide suite has no validity phase at all, so
             `inconclusive` is not among the verdicts its runs can
             reach. Showing it a greyed-out 80% completion floor would
             describe a rule that has never been applied to it. */
          <p className="text-[11px] text-muted-foreground/60">
            {EVAL_GRADING_VALIDITY_HINTS.notEnforced}
          </p>
        )}
      </SuiteSettingsRow>

      <SuiteSettingsRow
        settingKey="iterations"
        className="pr-6"
        chained={false}
        data-subsection-id="iterations"
        accessory={
          <LedgerRowChips
            dirty={rowIsDirty("iterations")}
            conflict={rowIsConflict("iterations")}
          />
        }
        hint={
          isVerdictPolicyV2
            ? EVAL_ITERATION_RULE_HINTS.defaultCount
            : EVAL_ITERATION_RULE_HINTS.caseCountWithFloor
        }
      >
        {isVerdictPolicyV2 ? (
          <PerCaseIterationsControl
            aligned
            defaults={draft.current.verdictPolicyDefaults}
            onChange={(next) =>
              dispatchDraft({
                type: "edit",
                key: "verdictPolicyDefaults",
                value: next,
              })
            }
          />
        ) : (
          <div
            className="flex items-center justify-between gap-4"
            data-setting-key="minimumIterations"
          >
            <span className="text-xs text-muted-foreground">
              {EVAL_ITERATION_RULE_LABELS.caseCountWithFloor}
            </span>
            <select
              className="h-8 w-40 shrink-0 rounded-md border border-input bg-background px-2 text-xs text-foreground"
              value={draft.current.minIterations ?? ""}
              aria-label="Minimum iterations per case for every run"
              onChange={(e) => {
                const raw = e.target.value;
                dispatchDraft({
                  type: "edit",
                  key: "minIterations",
                  value: raw === "" ? undefined : Number(raw),
                });
              }}
            >
              {/* "Off" is the suite's real state — no floor — and not a
                  stand-in for 1. */}
              <option value="">Off</option>
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        )}
      </SuiteSettingsRow>

      <SuiteSettingsRow
        settingKey="qualityGate"
        className="pr-6"
        chained={false}
        data-subsection-id="qualityGate"
        accessory={
          <LedgerRowChips
            dirty={rowIsDirty("qualityGate")}
            conflict={rowIsConflict("qualityGate")}
          />
        }
        hint="Fail a run when it regresses against a baseline run, whatever the pass criteria said."
      >
        <SuiteQualityGateSection
          simplified
          policy={draft.current.gatePolicy}
          onChange={(next) =>
            dispatchDraft({
              type: "edit",
              key: "gatePolicy",
              value: next,
            })
          }
          capabilities={capabilitiesReady ? capabilities : null}
          capabilitiesState={capabilitiesState}
        />
      </SuiteSettingsRow>
    </>
  );
}
