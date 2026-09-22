import type { ReactNode } from "react";
import { Settings2 } from "lucide-react";
import { ModelSelector } from "@/components/chat-v2/chat-input/model-selector";
import { ClientSelector } from "@/components/chat-v2/chat-input/client-selector";
import type { ModelDefinition } from "@/shared/types";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { Button } from "@mcpjam/design-system/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { cn } from "@mcpjam/design-system/cn";
import {
  parseModelValue,
  resolveModelOptionLabel,
} from "../../evals/compare-playground-helpers";

export type CaseSuiteChipOption = {
  value: string;
  label: string;
};

export type CaseSuiteChipsProps = {
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
  onOpenSuiteSettings?: () => void;
  disabled?: boolean;
};

const chipClassName = cn(
  "inline-flex max-w-[14rem] items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px]",
);

function ChipTrigger({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate text-foreground">{value}</span>
    </>
  );
}

function ChipMenu({
  label,
  value,
  children,
  disabled = false,
}: {
  label: string;
  value: string;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant="ghost"
          className={cn(chipClassName, "h-auto hover:bg-muted")}
          aria-label={label}
          disabled={disabled}
        >
          <ChipTrigger label={label} value={value} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[10rem]">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function CaseSuiteChips({
  models,
  modelLabelByValue = {},
  availableModels = [],
  onModelChange,
  trials,
  onTrialsChange,
  hostLabel,
  hostValue,
  hostOptions = [],
  onHostChange,
  onOpenSuiteSettings,
  disabled = false,
}: CaseSuiteChipsProps) {
  const themeMode = usePreferencesStore((state) => state.themeMode);
  const firstLabel =
    models.length === 0
      ? "Suite default"
      : resolveModelOptionLabel(models[0]!, modelLabelByValue);
  const modelValue =
    models.length <= 1 ? firstLabel : `${firstLabel} +${models.length - 1}`;
  const selectedModel = models[0] ?? "";
  const parsedModel = parseModelValue(selectedModel);
  const currentModel = availableModels.find(
    (model) => `${model.provider}/${String(model.id)}` === selectedModel,
  ) ?? {
    id: parsedModel.model,
    provider: parsedModel.provider || "unknown",
    name: modelValue,
  };
  const currentHostId = hostValue ?? hostOptions[0]?.value ?? null;

  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      data-testid="case-suite-chips"
    >
      <ModelSelector
        currentModel={
          models.length > 1
            ? { ...currentModel, name: modelValue }
            : currentModel
        }
        availableModels={availableModels}
        onModelChange={(model) =>
          onModelChange?.(`${model.provider}/${String(model.id)}`)
        }
        disabled={disabled || !onModelChange || availableModels.length === 0}
        analyticsLocation="eval_case"
      />
      <ChipMenu label="Iterations" value={String(trials)} disabled={disabled}>
        {onTrialsChange ? (
          <DropdownMenuRadioGroup
            value={String(trials)}
            onValueChange={(next) => onTrialsChange(Number(next))}
          >
            {Array.from({ length: 10 }, (_, index) => index + 1).map(
              (count) => (
                <DropdownMenuRadioItem
                  key={count}
                  value={String(count)}
                  className="text-xs"
                >
                  {count}
                </DropdownMenuRadioItem>
              ),
            )}
          </DropdownMenuRadioGroup>
        ) : (
          <DropdownMenuItem disabled className="text-xs">
            {trials}
          </DropdownMenuItem>
        )}
      </ChipMenu>
      <ClientSelector
        hosts={
          hostOptions.length > 0
            ? hostOptions.map((option) => ({
                hostId: option.value,
                name: option.label,
              }))
            : [{ hostId: "suite-default", name: hostLabel }]
        }
        projectId={null}
        cloudProjectId={null}
        currentHostId={hostOptions.length > 0 ? currentHostId : "suite-default"}
        selectedHostIds={currentHostId ? [currentHostId] : []}
        onHostChange={(hostId) => onHostChange?.(hostId)}
        onSelectedHostIdsChange={() => {}}
        onMultiHostEnabledChange={() => {}}
        onPromoteLead={() => {}}
        disabled={disabled || !onHostChange || hostOptions.length === 0}
        themeMode={themeMode}
      />
      {onOpenSuiteSettings ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label="Suite settings"
          title="Suite settings"
          onClick={onOpenSuiteSettings}
        >
          <Settings2 className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}
