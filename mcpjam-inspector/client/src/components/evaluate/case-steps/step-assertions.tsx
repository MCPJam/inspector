/**
 * The assertions nested under one step (or above step 1). Rows come from the
 * case spine: a tool-call assertion is the route's turn-scoped `RouteRow`,
 * every other assertion is `SpineCheckRow`, which collapses to one line.
 */

import type { Predicate } from "@/shared/eval-matching";
import type { TestStep } from "@/shared/steps";
import type { AvailableTool } from "@/components/evals/step-fields";
import {
  isToolCalledWithAssert,
  removeStepById,
} from "../simple-case/simple-case-model";
import { RouteRow, type ToolCatalogStatus } from "../case-scorecard/route-row";
import type {
  CaseScorecard,
  ScorecardRow,
} from "../case-scorecard/case-scorecard-model";
import { SpineCheckRow } from "../case-spine/spine-check-row";
import type { EditorAssertion } from "./case-steps-model";

type ToolCalledWith = Extract<Predicate, { type: "toolCalledWith" }>;

/** What every assertion row needs from the editor. */
export type StepAssertionsEnv = {
  steps: TestStep[];
  onStepsChange: (next: TestStep[]) => void;
  card: CaseScorecard;
  rowByStepId: Map<string, ScorecardRow>;
  availableTools: AvailableTool[];
  toolArgSchemas: Record<string, Record<string, unknown>>;
  toolsStatus?: ToolCatalogStatus;
  onRetryTools?: () => void;
  readOnly: boolean;
  checkPolicy: boolean;
  addedKey: string | null;
};

export function StepAssertions({
  assertions,
  env,
}: {
  assertions: EditorAssertion[];
  env: StepAssertionsEnv;
}) {
  if (assertions.length === 0) return null;
  return (
    <ul
      className="divide-y divide-border overflow-hidden rounded-lg border border-border"
      data-testid="case-steps-assertions"
    >
      {assertions.map(({ step }) => {
        const toolPredicate = readToolCalledWith(step);
        if (toolPredicate)
          return (
            <ToolCalledRow
              key={step.id}
              stepId={step.id}
              predicate={toolPredicate}
              env={env}
            />
          );
        return (
          <SpineCheckRow
            key={step.id}
            step={step}
            row={env.rowByStepId.get(step.id)}
            availableTools={env.availableTools}
            readOnly={env.readOnly}
            checkPolicy={env.checkPolicy}
            status={undefined}
            newest={env.addedKey === `step:${step.id}`}
            defaultOpen={env.addedKey === `step:${step.id}`}
            onChange={(next) =>
              env.onStepsChange(
                env.steps.map((item) => (item.id === next.id ? next : item)),
              )
            }
            onRemove={() =>
              env.onStepsChange(removeStepById(env.steps, step.id))
            }
          />
        );
      })}
    </ul>
  );
}

function readToolCalledWith(step: TestStep): ToolCalledWith | null {
  if (!isToolCalledWithAssert(step) || step.kind !== "assert") return null;
  const { assertion } = step;
  return "type" in assertion && assertion.type === "toolCalledWith"
    ? assertion
    : null;
}

/**
 * "Tool was called with" under a step. The same row the case spine shows for
 * a turn-scoped tool assertion, so editing a tool or its arguments works the
 * same on both pages.
 */
function ToolCalledRow({
  stepId,
  predicate,
  env,
}: {
  stepId: string;
  predicate: ToolCalledWith;
  env: StepAssertionsEnv;
}) {
  const route = env.card.route.route;
  const replaceAssertion = (assertion: ToolCalledWith) =>
    env.onStepsChange(
      env.steps.map((step) =>
        step.id === stepId && step.kind === "assert"
          ? { ...step, assertion }
          : step,
      ),
    );
  const remove = () => env.onStepsChange(removeStepById(env.steps, stepId));
  if (route?.kind !== "tools") {
    return (
      <li className="flex items-center gap-2 px-3 py-2 text-sm">
        <span className="text-card-foreground">Tool was called with:</span>
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
          {predicate.toolName || "no tool picked"}
        </code>
      </li>
    );
  }
  return (
    <RouteRow
      paper
      turnScoped
      toolArgSchemas={env.toolArgSchemas}
      toolPredicate={predicate}
      onChangeToolPredicate={replaceAssertion}
      newestStepId={
        env.addedKey?.startsWith("step:") ? env.addedKey.slice(5) : undefined
      }
      row={{
        ...env.card.route,
        key: `step:${stepId}`,
        route: {
          ...route,
          tools: [
            {
              id: stepId,
              toolName: predicate.toolName,
              arguments: predicate.args?.args ?? {},
            },
          ],
        },
      }}
      availableTools={env.availableTools.map((tool) => tool.name)}
      toolsStatus={env.toolsStatus}
      onRetryTools={env.onRetryTools}
      readOnly={env.readOnly}
      showUnsetError={false}
      negativeContradiction={false}
      onSetTools={(next) => {
        const tool = next[0];
        if (!tool) return remove();
        replaceAssertion({
          ...predicate,
          toolName: tool.toolName,
          args: { ...predicate.args, args: tool.arguments ?? {} },
        });
      }}
      onChooseNoTool={() => {}}
      onChooseTools={() => {}}
      onAddTool={() => {}}
      onSetKind={() => {}}
    />
  );
}
