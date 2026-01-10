import { useMemo, useState } from "react";
import { Grid3x3, List, Search, AlertCircle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { UserModelCard } from "./user-model-card";
import type { ModelDefinition } from "@/shared/types";
import { isMCPJamProvidedModel } from "@/shared/types";

interface UserModelSelectorProps {
  selectedModel: ModelDefinition | null;
  availableModels: ModelDefinition[];
  onModelChange: (model: ModelDefinition) => void;
  missingApiKey?: boolean;
  providerName?: string;
}

type ViewMode = "grid" | "list";

export function UserModelSelector({
  selectedModel,
  availableModels,
  onModelChange,
  missingApiKey,
  providerName,
}: UserModelSelectorProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [searchQuery, setSearchQuery] = useState("");

  // Filter out MCPJam provided models and apply search
  const filteredModels = useMemo(() => {
    // First filter out MCPJam provided models
    const userModels = availableModels.filter(
      (model) => !isMCPJamProvidedModel(String(model.id)),
    );

    // Then apply search filter
    if (!searchQuery.trim()) {
      return userModels;
    }

    const query = searchQuery.toLowerCase();
    return userModels.filter(
      (model) =>
        model.name.toLowerCase().includes(query) ||
        String(model.id).toLowerCase().includes(query) ||
        model.provider.toLowerCase().includes(query),
    );
  }, [availableModels, searchQuery]);

  // Check if a model is selected
  const isModelSelected = (model: ModelDefinition): boolean => {
    return selectedModel?.id === model.id;
  };

  return (
    <div className="space-y-4">
      {/* Search and view controls */}
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

      {/* API Key Warning */}
      {missingApiKey && providerName && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm">
          <AlertCircle className="mt-0.5 h-4 w-4 text-destructive" />
          <div>
            <p className="font-medium text-destructive">
              Add your {providerName} API key
            </p>
            <p className="text-muted-foreground">
              Configure credentials in Settings to run this model. Keys are
              stored locally and never sent to our servers.
            </p>
          </div>
        </div>
      )}

      {/* No models state */}
      {filteredModels.length === 0 && (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <p className="text-sm text-muted-foreground">
            {searchQuery
              ? `No models found matching "${searchQuery}"`
              : "No models configured. Add your API keys in Settings."}
          </p>
        </div>
      )}

      {/* Models grid/list */}
      {filteredModels.length > 0 && (
        <div
          className={cn(
            "gap-4",
            viewMode === "grid"
              ? "grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3"
              : "flex flex-col",
          )}
        >
          {filteredModels.map((model) => (
            <UserModelCard
              key={model.id}
              model={model}
              isSelected={isModelSelected(model)}
              onSelect={onModelChange}
            />
          ))}
        </div>
      )}
    </div>
  );
}
