/**
 * After-run assertions: the route rule, the suite's defaults, then the case's
 * own predicates, in the order `afterRunSection` gives them.
 */
import { Ban, ListOrdered, ShieldCheck } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { CheckRow } from "@/components/evals/checks-section";
import type { AvailableTool } from "@/components/evals/step-fields";
import { ROUTE_CHECK_LABELS } from "@/components/evals/eval-add-catalog";
import type { ScorecardRow } from "../case-scorecard/case-scorecard-model";
import { EvalAddDrawer } from "../case-spine/assertion-drawer";
import { assertionSummary } from "./assertion-summary";
import type { AfterRunSection } from "./case-steps-model";
import {
  ADD_SMALL,
  InheritedLock,
  NonBlockingChip,
  ProvenanceChip,
  RoleControl,
  StepMenu,
  StepRow,
  StepSection,
} from "./case-step-parts";
import {
  addAfterRun,
  chooseTools,
  nextCasePredicateIndex,
  setCaseKind,
  setCasePredicates,
  setEnvelopeMode,
  type CaseStepsDraft,
  type DraftEdit,
} from "./case-step-edits";

const ROUTE_BODY = {
  noTools:
    "Passes when the agent makes no tool calls. While it is on, “Tool was called with” assertions are set aside.",
  exactOrder:
    "Calls must follow this order, with no extra calls. The order comes from the “Tool was called with” assertions; edit arguments there.",
} as const;

function rowSummary(row: ScorecardRow) {
  return row.predicate
    ? assertionSummary(row.predicate, false)
    : { label: row.label, Icon: ShieldCheck };
}

export function CaseAfterRun({
  ordinal,
  section,
  draft,
  suiteName,
  suiteDefaultMatchOptions,
  availableTools,
  readOnly,
  openKey,
  flashKey,
  onToggle,
  onOpen,
  onEdit,
  onOpenSuiteSettings,
}: {
  ordinal: number;
  section: AfterRunSection;
  draft: CaseStepsDraft;
  suiteName: string;
  suiteDefaultMatchOptions: CaseStepsDraft["matchOptions"];
  availableTools: AvailableTool[];
  readOnly: boolean;
  openKey: string | null;
  flashKey: string | null;
  onToggle: (key: string) => void;
  onOpen: (key: string | null) => void;
  onEdit: (edit: DraftEdit) => void;
  onOpenSuiteSettings: () => void;
}) {
  const toolNames = availableTools.map((tool) => tool.name);
  const route = section.route;
  const menu = (
    label: string,
    items: Parameters<typeof StepMenu>[0]["items"],
  ) => (readOnly ? null : <StepMenu label={label} items={items} />);
  const replaced = section.replacedSuiteCount;
  return (
    <StepSection
      marker={ordinal}
      id="case-steps-after-run"
      anchor="after-run"
      flash={flashKey === "after-run"}
      title="After-run assertions"
      subtitle="Whole-run rules, graded once over the finished transcript."
      last
    >
      <div className="space-y-2">
        {draft.predicates?.mode === "replace" ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
            <span>
              {`Suite evaluators replaced for this case: ${replaced === 1 ? "1 is not applied" : `${replaced} are not applied`}.`}
            </span>
            {readOnly ? null : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[11px]"
                onClick={() =>
                  onEdit((current) => setEnvelopeMode(current, "extend"))
                }
              >
                Apply suite evaluators too
              </Button>
            )}
          </div>
        ) : null}
        <ul className="space-y-2">
          {route ? (
            <StepRow
              anchor="route"
              open={openKey === "route"}
              flash={flashKey === "route"}
              onToggle={() => onToggle("route")}
              Icon={route.kind === "noTools" ? Ban : ListOrdered}
              iconClass="text-success"
              label={ROUTE_CHECK_LABELS[route.kind]}
              value={
                route.kind === "exactOrder"
                  ? route.toolNames.join(" → ")
                  : undefined
              }
              chips={<ProvenanceChip />}
              menu={menu(ROUTE_CHECK_LABELS[route.kind], [
                {
                  label: "Remove",
                  onSelect: () =>
                    onEdit(
                      route.kind === "noTools"
                        ? chooseTools
                        : (current) =>
                            setCaseKind(
                              current,
                              "capability",
                              suiteDefaultMatchOptions,
                            ),
                    ),
                },
              ])}
            >
              <p className="text-[13px] text-card-foreground">
                {ROUTE_BODY[route.kind]}
              </p>
            </StepRow>
          ) : null}
          {section.suiteRows.map((row, index) => {
            const s = rowSummary(row);
            const key = `suite:${index}`;
            return (
              <StepRow
                key={key}
                anchor={key}
                open={openKey === key}
                flash={flashKey === key}
                onToggle={() => onToggle(key)}
                Icon={s.Icon}
                iconClass="text-muted-foreground"
                label={s.label}
                value={"value" in s ? s.value : undefined}
                chips={
                  <>
                    {row.role === "advisory" ? <NonBlockingChip /> : null}
                    <ProvenanceChip suite />
                    <InheritedLock />
                  </>
                }
                menu={menu(s.label, [
                  {
                    label: "Edit in suite settings",
                    onSelect: onOpenSuiteSettings,
                  },
                  {
                    label: "Replace suite evaluators for this case",
                    onSelect: () =>
                      onEdit((current) => setEnvelopeMode(current, "replace")),
                  },
                ])}
              >
                <p className="text-[13px] text-card-foreground">
                  {`Set in suite settings and applied to every case in ${suiteName}. `}
                  <button
                    type="button"
                    onClick={onOpenSuiteSettings}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    Open suite settings
                  </button>
                </p>
              </StepRow>
            );
          })}
          {section.caseRows.map((row) => {
            const index = row.predicateIndex ?? 0;
            const predicate = row.predicate;
            const s = rowSummary(row);
            const key = `case:${index}`;
            const setPredicate = (next: typeof predicate) =>
              next &&
              onEdit((current) =>
                setCasePredicates(current, (list) =>
                  list.map((item, i) => (i === index ? next : item)),
                ),
              );
            return (
              <StepRow
                key={key}
                anchor={key}
                open={openKey === key}
                flash={flashKey === key}
                onToggle={() => onToggle(key)}
                Icon={s.Icon}
                iconClass="text-success"
                label={s.label}
                value={"value" in s ? s.value : undefined}
                missing={"missing" in s ? s.missing : undefined}
                chips={
                  <>
                    {row.role === "advisory" ? <NonBlockingChip /> : null}
                    <ProvenanceChip />
                  </>
                }
                menu={menu(s.label, [
                  {
                    label: "Remove",
                    onSelect: () =>
                      onEdit((current) =>
                        setCasePredicates(current, (list) =>
                          list.filter((_, i) => i !== index),
                        ),
                      ),
                  },
                ])}
              >
                {predicate ? (
                  <fieldset disabled={readOnly} className="min-w-0 space-y-3">
                    <RoleControl
                      predicate={predicate}
                      readOnly={readOnly}
                      onChange={setPredicate}
                    />
                    <CheckRow
                      noun="assertion"
                      embedded
                      paper
                      predicate={predicate}
                      availableTools={toolNames}
                      readOnly={readOnly}
                      onChange={setPredicate}
                    />
                  </fieldset>
                ) : null}
              </StepRow>
            );
          })}
        </ul>
        {section.isEmpty ? (
          <p className="text-sm text-muted-foreground">
            Nothing graded after the run yet.
          </p>
        ) : null}
      </div>
      {readOnly ? null : (
        <div className="mt-3">
          <EvalAddDrawer
            triggerLabel="Add after-run assertion"
            title="Add an after-run assertion"
            description="Graded once, over the finished transcript."
            allowRouteChecks
            filter={(entry) => entry.scope === "whole-run"}
            className={ADD_SMALL}
            onSelect={(choice) => {
              const result = addAfterRun(
                choice,
                suiteDefaultMatchOptions,
                nextCasePredicateIndex(draft),
              );
              if (!result) return;
              onEdit(result.edit);
              onOpen(result.openKey);
            }}
          />
        </div>
      )}
    </StepSection>
  );
}
