/**
 * The steps editor for a case not saved yet, behind
 * `eval-test-case-steps-editor`:
 * - Describe's draft. Today's editor keeps the form, Ask MCPJam's edits and
 *   Save case; this only draws the form as steps.
 * - A generated draft under review. The generation store keeps it until Add
 *   to suite.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import type { CaseSaveForm } from "@/components/evals/case-save-payload";
import type { AvailableTool } from "@/components/evals/step-fields";
import type { EvalSuite } from "@/components/evals/types";
import { useActorCanQuery } from "@/hooks/use-actor-can-query";
import {
  useSuiteCapabilities,
  type SuiteCapabilities,
} from "@/hooks/use-suite-capabilities";
import type { RemoteServer } from "@/hooks/useProjects";
import { buildEvaluatePath, navigateApp } from "@/lib/app-navigation";
import type { SuiteSettingsTab } from "@/lib/eval-route-types";
import {
  editGeneratedDraft,
  type GeneratedDraft,
} from "@/lib/mcpjam-agent/eval-workspace";
import type { EvalAgentScope } from "@/shared/eval-agent-scope";
import type {
  SimpleCaseTool,
  ToolsChoice,
} from "../simple-case/simple-case-model";
import type { CaseStepsDraft, DraftEdit } from "./case-step-edits";
import { CaseStepsEditor } from "./case-steps-editor";
import { caseStepsScorecard, caseStepsSuiteFacts } from "./case-steps-suite";
import {
  generatedDraftPatch,
  generatedDraftToSteps,
  stepsFormFields,
} from "./draft-case-steps-model";

type DraftStepsProps = {
  draft: CaseStepsDraft;
  onDraftChange: (edit: DraftEdit) => void;
  suite: EvalSuite;
  capabilities: SuiteCapabilities | null | undefined;
  availableTools: AvailableTool[];
  projectServers?: RemoteServer[];
  readOnly: boolean;
  caseOverrides?: boolean;
  onOpenSuiteSettings: (tab: SuiteSettingsTab) => void;
  onDraftValidityChange?: (invalid: boolean) => void;
};

function DraftSteps({ suite, capabilities, ...props }: DraftStepsProps) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const judgePolicy = capabilities?.judges?.goalCompletion.policy;
  const card = useMemo(
    () => caseStepsScorecard(props.draft, suite, judgePolicy),
    [props.draft, suite, judgePolicy],
  );
  return (
    <CaseStepsEditor
      {...props}
      card={card}
      suite={caseStepsSuiteFacts(suite, capabilities)}
      openKey={openKey}
      onOpenKeyChange={setOpenKey}
    />
  );
}

export type DescribeCaseStepsProps = {
  form: CaseSaveForm;
  onFormChange: (update: (form: CaseSaveForm) => CaseSaveForm) => void;
  /** Today's editor owns the tool question and the stashed tools. */
  toolsChoice: ToolsChoice;
  onToolsChoiceChange: (choice: ToolsChoice) => void;
  stashedTools: SimpleCaseTool[];
  onStashedToolsChange: (tools: SimpleCaseTool[]) => void;
  suite: EvalSuite | null | undefined;
  capabilities: SuiteCapabilities | null | undefined;
  availableTools: AvailableTool[];
  projectServers?: RemoteServer[];
  onOpenSuiteSettings: (tab: SuiteSettingsTab) => void;
  onDraftValidityChange: (invalid: boolean) => void;
};

export function DescribeCaseSteps({
  form,
  onFormChange,
  toolsChoice,
  onToolsChoiceChange,
  stashedTools,
  onStashedToolsChange,
  suite,
  ...props
}: DescribeCaseStepsProps) {
  const draft = useMemo<CaseStepsDraft>(
    () => ({
      ...form,
      expectedOutput: form.expectedOutput ?? "",
      toolsChoice,
      stashedTools,
    }),
    [form, toolsChoice, stashedTools],
  );
  // Edits in one event chain off each other, not off the last render.
  const latest = useRef(draft);
  latest.current = draft;
  if (!suite) return null;
  const onDraftChange = (edit: DraftEdit) => {
    const next = edit(latest.current);
    latest.current = next;
    onFormChange((current) => ({ ...current, ...stepsFormFields(next) }));
    if (next.toolsChoice !== toolsChoice) onToolsChoiceChange(next.toolsChoice);
    if (next.stashedTools !== stashedTools)
      onStashedToolsChange(next.stashedTools);
  };
  return (
    <DraftSteps
      {...props}
      draft={draft}
      onDraftChange={onDraftChange}
      suite={suite}
      readOnly={false}
    />
  );
}

/**
 * A generated draft as the editor's draft. Edits write to the generation
 * store as they happen; an edit from elsewhere (Ask MCPJam) reloads it.
 */
export function useGeneratedDraftSteps(
  scope: EvalAgentScope,
  generated: GeneratedDraft,
) {
  const [draft, setDraft] = useState(() =>
    generatedDraftToSteps(generated.input),
  );
  const latest = useRef(draft);
  // The revision this editor last seeded from or wrote.
  const revision = useRef(generated.revision);
  useEffect(() => {
    if (generated.revision === revision.current) return;
    revision.current = generated.revision;
    const next = generatedDraftToSteps(generated.input);
    latest.current = next;
    setDraft(next);
  }, [generated.revision, generated.input]);
  const onDraftChange = (edit: DraftEdit) => {
    let next = edit(latest.current);
    try {
      revision.current = editGeneratedDraft(
        scope,
        generated.id,
        revision.current,
        generatedDraftPatch(next),
      ).revision;
    } catch {
      // Changed elsewhere or saving: show the store's draft, not an edit it
      // never took; the effect brings any newer revision.
      next = generatedDraftToSteps(generated.input);
    }
    latest.current = next;
    setDraft(next);
  };
  return { draft, onDraftChange };
}

export function GeneratedDraftSteps({
  scope,
  generated,
  availableTools,
  readOnly,
}: {
  scope: EvalAgentScope;
  generated: GeneratedDraft;
  availableTools: AvailableTool[];
  readOnly: boolean;
}) {
  const canQuery = useActorCanQuery();
  const suite = useQuery(
    "testSuites:getTestSuite" as never,
    canQuery ? ({ suiteId: scope.suiteId } as never) : "skip",
  ) as EvalSuite | null | undefined;
  const capabilities = useSuiteCapabilities(scope.suiteId).capabilities;
  const { draft, onDraftChange } = useGeneratedDraftSteps(scope, generated);
  if (!suite) return null;
  return (
    <DraftSteps
      draft={draft}
      onDraftChange={onDraftChange}
      suite={suite}
      capabilities={capabilities}
      availableTools={availableTools}
      readOnly={readOnly}
      caseOverrides={false}
      onOpenSuiteSettings={(tab) =>
        navigateApp(
          buildEvaluatePath({
            type: "suite-edit",
            suiteId: scope.suiteId,
            ...(tab === "evaluators" ? { tab } : {}),
          }),
        )
      }
    />
  );
}
