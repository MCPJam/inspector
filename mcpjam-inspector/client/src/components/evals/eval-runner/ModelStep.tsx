import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { isMCPJamProvidedModel, type ModelDefinition } from "@/shared/types";

interface ModelStepProps {
  availableModels: ModelDefinition[];
  selectedModels: ModelDefinition[];
  modelTab: "mcpjam" | "yours";
  onModelTabChange: (tab: "mcpjam" | "yours") => void;
  onToggleModel: (model: ModelDefinition) => void;
}

export function ModelStep({
  availableModels,
  selectedModels,
  modelTab,
  onModelTabChange,
  onToggleModel,
}: ModelStepProps) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg pb-2">Choose evaluation models</h3>
        <p className="text-sm text-muted-foreground">
          Select one or more models. Each test will run against all selected
          models.
        </p>
      </div>

      <div className="flex items-center gap-1 rounded-lg border p-1 w-fit">
        <button
          type="button"
          onClick={() => onModelTabChange("mcpjam")}
          className={cn(
            "rounded-md px-4 py-2 text-sm font-medium transition-colors",
            modelTab === "mcpjam"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          MCPJam Free Models
        </button>
        <button
          type="button"
          onClick={() => onModelTabChange("yours")}
          className={cn(
            "rounded-md px-4 py-2 text-sm font-medium transition-colors",
            modelTab === "yours"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          Your Providers
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
        {availableModels
          .filter((model) =>
            modelTab === "mcpjam"
              ? isMCPJamProvidedModel(model.id)
              : !isMCPJamProvidedModel(model.id),
          )
          .map((model) => {
            const isSelected = selectedModels.some((m) => m.id === model.id);

            return (
              <button
                key={model.id}
                type="button"
                onClick={() => onToggleModel(model)}
                className={cn(
                  "rounded-xl border p-4 text-left transition-colors relative",
                  isSelected
                    ? "border-primary bg-primary/5"
                    : "hover:border-primary/40",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h4 className="font-semibold text-sm">{model.name}</h4>
                      {isSelected && (
                        <Check className="h-4 w-4 text-primary shrink-0" />
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      by {model.provider}
                    </p>
                  </div>
                </div>
              </button>
            );
          })}
      </div>

      {selectedModels.length > 0 && (
        <div className="rounded-lg border bg-muted/30 p-3">
          <p className="text-sm font-medium">
            {selectedModels.length} model
            {selectedModels.length === 1 ? "" : "s"} selected
          </p>
        </div>
      )}
    </div>
  );
}
