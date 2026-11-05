import { Button } from "@mcpjam/design-system/button";
import type { EvalSuiteSettingKey } from "@/shared/eval-suite-settings-manifest";
import { CI_OWNED_REASON_COPY } from "../capability-reasons";
import type { SuiteSettingsKey } from "../suite-settings-draft";

/** Which draft keys make each settings row show as unsaved or conflicting. */
export const ROW_DRAFT_KEYS: Partial<
  Record<EvalSuiteSettingKey, SuiteSettingsKey[]>
> = {
  name: ["name"],
  checks: ["defaultPredicates"],
  // Partitioned by ROW, so a dirty badge names the row that is actually
  // dirty. One `policy` entry used to carry all five keys, which meant
  // editing the quality gate lit the criterion row's badge and editing the
  // threshold lit the gate's — invisible while the three were one row, and
  // wrong the moment they were not.
  //
  // `verdictPolicyDefaults` is the one key that genuinely belongs to more
  // than one row: it is a single stored object holding the threshold, the
  // count and the validity block. Splitting it here would need a deep diff of
  // a stored shape, and a badge that under-reports is worse than one that
  // over-reports — so both rows watch it and say so.
  policy: ["defaultPassCriteria", "verdictPolicyDefaults"],
  iterations: ["minIterations", "verdictPolicyDefaults"],
  qualityGate: ["gatePolicy"],
  validity: ["verdictPolicyDefaults"],
  passOrFail: [
    "defaultMatchOptions",
    "defaultPredicates",
    "judgeConfig",
    "judgeRubric",
  ],
  computerEnvironment: ["computerEnvironmentId"],
  // One clock per row, so each badge names exactly the clock it belongs to.
  turnTimeoutMs: ["turnTimeoutMs"],
  toolCallTimeoutMs: ["toolCallTimeoutMs"],
  iterationTimeoutMs: ["iterationTimeoutMs"],
  runTimeoutMs: ["runTimeoutMs"],
  turnRetries: ["turnRetries"],
};

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
export function SuiteCiOwnedNotice({
  onDuplicate,
}: {
  onDuplicate?: () => void;
}) {
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
