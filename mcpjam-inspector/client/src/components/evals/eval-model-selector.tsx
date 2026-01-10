import { useMemo, useState } from "react";
import { Grid3x3, List, Search, Loader2, AlertCircle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useModelMetadata } from "@/hooks/use-model-metadata";
import { ModelCard } from "./model-card";
import type { OpenRouterModel } from "@/types/model-metadata";
import type { ModelDefinition } from "@/shared/types";

interface EvalModelSelectorProps {
  selectedModel: ModelDefinition | null;
  availableModels: ModelDefinition[];
  onModelChange: (model: ModelDefinition) => void;
}

type ViewMode = "grid" | "list";

/**
 * Convert OpenRouterModel to ModelDefinition
 */
function openRouterToModelDefinition(
  orModel: OpenRouterModel,
): ModelDefinition {
  // Extract provider from model ID (e.g., "openai/gpt-5" -> "openai")
  const parts = orModel.id.split("/");
  const provider = parts[0] as any; // Type assertion since we know these are valid providers

  return {
    id: orModel.id,
    name: orModel.name,
    provider: provider,
  };
}

export function EvalModelSelector({
  selectedModel,
  availableModels,
  onModelChange,
}: EvalModelSelectorProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [searchQuery, setSearchQuery] = useState("");
  const { models, isLoading, error } = useModelMetadata();

  // Filter models based on search query
  const filteredModels = useMemo(() => {
    if (!searchQuery.trim()) {
      return models;
    }

    const query = searchQuery.toLowerCase();
    return models.filter(
      (model) =>
        model.name.toLowerCase().includes(query) ||
        model.id.toLowerCase().includes(query) ||
        model.description.toLowerCase().includes(query),
    );
  }, [models, searchQuery]);

  // Check if a model is selected
  const isModelSelected = (model: OpenRouterModel): boolean => {
    return selectedModel?.id === model.id;
  };

  const handleSelectModel = (model: OpenRouterModel) => {
    const modelDef = openRouterToModelDefinition(model);
    onModelChange(modelDef);
  };

  return (
    <div className="space-y-4">
      {/* Header with search and view controls */}
      <div className="flex items-center justify-between gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Filter models"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        <div className="flex items-center gap-1">
          <div className="flex items-center gap-1 rounded-md border p-1">
            <Button
              type="button"
              variant={viewMode === "grid" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setViewMode("grid")}
              className="h-7 w-7 p-0"
              aria-label="Grid view"
            >
              <Grid3x3 className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant={viewMode === "list" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setViewMode("list")}
              className="h-7 w-7 p-0"
              aria-label="List view"
            >
              <List className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Model count and reset */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {filteredModels.length} model{filteredModels.length !== 1 ? "s" : ""}
        </p>
        {searchQuery && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setSearchQuery("")}
          >
            Reset Filters
          </Button>
        )}
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="flex items-center justify-center rounded-lg border p-12">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Loading model metadata...
            </p>
          </div>
        </div>
      )}

      {/* Error state */}
      {error && !isLoading && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/5 p-4">
          <AlertCircle className="mt-0.5 h-5 w-5 text-destructive" />
          <div className="flex-1">
            <p className="font-medium text-destructive">
              Failed to load model metadata
            </p>
            <p className="mt-1 text-sm text-muted-foreground">{error}</p>
          </div>
        </div>
      )}

      {/* Models grid/list */}
      {!isLoading && !error && filteredModels.length === 0 && (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <p className="text-sm text-muted-foreground">
            {searchQuery
              ? `No models found matching "${searchQuery}"`
              : "No models available"}
          </p>
        </div>
      )}

      {!isLoading && !error && filteredModels.length > 0 && (
        <div
          className={cn(
            "gap-4",
            viewMode === "grid"
              ? "grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3"
              : "flex flex-col",
          )}
        >
          {filteredModels.map((model) => (
            <ModelCard
              key={model.id}
              model={model}
              isSelected={isModelSelected(model)}
              onSelect={handleSelectModel}
            />
          ))}
        </div>
      )}
    </div>
  );
}
