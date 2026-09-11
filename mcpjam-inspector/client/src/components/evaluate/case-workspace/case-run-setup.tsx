import { Play } from "lucide-react";
import { RunIterationControl } from "../run-iteration-control";
import { EvalTargetMatrix, EvalModelChoices } from "../eval-target-matrix";
import { parseModelValue } from "../../evals/compare-playground-helpers";
import { Button } from "@mcpjam/design-system/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@mcpjam/design-system/sheet";
import { type CaseSuiteChipsProps } from "../simple-case/case-suite-chips";

export function CaseRunSetup({
  open,
  onOpenChange,
  caseTitle,
  onStart,
  runDisabled,
  disabledReason,
  onModelsChange,
  ...controls
}: Omit<CaseSuiteChipsProps, "onOpenSuiteSettings"> & {
  onModelsChange?: (models: string[]) => void;
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
  const modelIds = controls.models.map((value) => parseModelValue(value).model);
  const selection = {
    includeClientDefaults: false,
    explicitModelIds: modelIds,
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
            renderModels={() => (
              <EvalModelChoices
                inModal
                value={selection}
                availableModels={availableModels}
                disabled={Boolean(controls.disabled)}
                testId="case-run-models"
                onChange={(next) => {
                  const values = next.explicitModelIds.map((id) => {
                    const model = availableModels.find(
                      (model) => String(model.id) === id,
                    );
                    return model
                      ? `${model.provider}/${id}`
                      : (controls.models.find(
                          (value) => parseModelValue(value).model === id,
                        ) ?? id);
                  });
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
