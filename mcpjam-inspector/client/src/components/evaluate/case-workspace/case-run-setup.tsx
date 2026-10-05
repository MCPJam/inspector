import { Play } from "lucide-react";
import { RunIterationControl } from "../run-iteration-control";
import { EvalTargetMatrix, EvalModelChoices } from "../eval-target-matrix";
import {
  parseModelValue,
  quickRunModelValue,
} from "../../evals/compare-playground-helpers";
import { modelTarget } from "@/lib/model-target";
import { Button } from "@mcpjam/design-system/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@mcpjam/design-system/sheet";
import type { ModelDefinition } from "@/shared/types";
import { ServerPicker } from "@/components/hosts/server-picker";
import type { ModelSelection } from "@mcpjam/sdk/browser";

export type CaseSuiteChipOption = {
  value: string;
  label: string;
};

/** One quick-run pick: a model value and, at a chosen effort, its selection. */
export type CaseRunPick = { modelValue: string; selection?: ModelSelection };

/** The run controls a case workspace hands the Setup Run sheet. */
export type CaseRunControls = {
  /** Quick-run keys (`quickRunKey`): a model value, plus its effort if any. */
  models: string[];
  modelLabelByValue?: Record<string, string>;
  availableModels?: ModelDefinition[];
  onModelChange?: (next: string) => void;
  trials: number;
  onTrialsChange?: (next: number) => void;
  hostLabel: string;
  hostValue?: string;
  hostOptions?: CaseSuiteChipOption[];
  onHostChange?: (next: string) => void;
  disabled?: boolean;
};

export function CaseRunSetup({
  open,
  onOpenChange,
  caseTitle,
  onStart,
  runDisabled,
  disabledReason,
  onModelsChange,
  onPicksChange,
  selections,
  environmentSelection,
  serverGroup,
  ...controls
}: CaseRunControls & {
  /**
   * Environment suites only: the picks with their efforts. Turns on the
   * effort menus, so one model can run at several efforts (Low, Medium, High),
   * each its own run. Without it the sheet writes plain model values.
   */
  onPicksChange?: (picks: CaseRunPick[]) => void;
  /** The selection behind each key in `models` that has one. */
  selections?: Readonly<Record<string, ModelSelection>>;
  /**
   * Environment suites only: the selection the suite's environment runs a
   * model at (by model id). A pick with no selection of its own runs at it,
   * so its effort menu starts there.
   */
  environmentSelection?: (modelId: string) => ModelSelection | undefined;
  onModelsChange?: (models: string[]) => void;
  /**
   * Environment suites only: the server group the run's environments use.
   * Defaults to the group the suite's environments share; there is no "none",
   * because an eval environment without a group runs with no servers.
   */
  serverGroup?: {
    projectId: string;
    value: string | null;
    onChange: (serverAttachmentId: string) => void;
  };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  caseTitle: string;
  onStart: () => void;
  runDisabled: boolean;
  disabledReason?: string | null;
}) {
  const hosts = controls.hostOptions?.length
    ? controls.hostOptions.map((option) => ({
        hostId: option.value,
        name: option.label,
        modelId: "",
      }))
    : [{ hostId: "suite-default", name: controls.hostLabel, modelId: "" }];
  const hostId =
    controls.hostValue &&
    hosts.some((host) => host.hostId === controls.hostValue)
      ? controls.hostValue
      : hosts[0].hostId;
  const availableModels = controls.availableModels ?? [];
  const effortEditable = onPicksChange !== undefined;
  const targets = controls.models.map((key) => {
    const modelId = parseModelValue(key).model;
    return modelTarget(
      modelId,
      effortEditable
        ? (selections?.[key] ?? environmentSelection?.(modelId))
        : undefined,
    );
  });
  const selection = { includeClientDefaults: false, explicitTargets: targets };
  // The editor keys picks by model value (`provider/model`).
  const modelValueFor = (modelId: string) => {
    const model = availableModels.find((row) => String(row.id) === modelId);
    return model
      ? `${model.provider}/${modelId}`
      : (controls.models
          .map(quickRunModelValue)
          .find((value) => parseModelValue(value).model === modelId) ??
          modelId);
  };
  const validCount =
    Number.isInteger(controls.trials) &&
    controls.trials >= 1 &&
    controls.trials <= 10;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-xl">
        <SheetHeader className="border-b border-border px-6 py-4 pr-12">
          <SheetTitle>Setup Run</SheetTitle>
          <SheetDescription>{caseTitle}</SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-5 overflow-y-auto p-6">
          <RunIterationControl
            value={String(controls.trials)}
            onChange={(value) => controls.onTrialsChange?.(Number(value))}
            disabled={controls.disabled}
          />
          {serverGroup ? (
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Servers</p>
              <ServerPicker
                projectId={serverGroup.projectId}
                value={serverGroup.value}
                onChange={(id) => {
                  if (id) serverGroup.onChange(id);
                }}
                offerClear={false}
                variant="field"
                inModal
                disabled={controls.disabled}
                emptyTriggerLabel="Pick a server group"
                triggerTestId="case-run-server-group"
              />
            </div>
          ) : null}
          <EvalTargetMatrix
            hostIds={[hostId]}
            hosts={hosts}
            modelSelection={selection}
            availableModels={availableModels}
            maxTargets={100}
            projectId=""
            singleClient
            inModal
            modelsEditable
            disabled={controls.disabled}
            onHostsChange={(ids) => controls.onHostChange?.(ids[0])}
            onRemoveClient={() => {}}
            onModelSelectionChange={() => {}}
            renderModels={(_hostId, harness) => (
              <EvalModelChoices
                harness={harness}
                inModal
                effortEditable={effortEditable}
                value={selection}
                availableModels={availableModels}
                disabled={Boolean(controls.disabled)}
                testId="case-run-models"
                onChange={(next) => {
                  const picks = next.explicitTargets.map((target) => ({
                    modelValue: modelValueFor(target.modelId),
                    ...(target.selection
                      ? { selection: target.selection }
                      : {}),
                  }));
                  if (onPicksChange) {
                    onPicksChange(picks);
                    return;
                  }
                  const values = [
                    ...new Set(picks.map((pick) => pick.modelValue)),
                  ];
                  if (onModelsChange) onModelsChange(values);
                  else if (values[0]) controls.onModelChange?.(values[0]);
                }}
              />
            )}
          />
        </div>
        <div className="space-y-3 border-t border-border p-6">
          {disabledReason && (
            <p className="text-sm text-muted-foreground">{disabledReason}</p>
          )}
          <Button
            className="w-full"
            disabled={runDisabled || !validCount}
            onClick={() => {
              onOpenChange(false);
              onStart();
            }}
          >
            <Play className="size-4" aria-hidden />
            Run test case
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
