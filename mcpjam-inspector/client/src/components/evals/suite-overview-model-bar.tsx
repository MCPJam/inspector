import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { Badge } from "@mcpjam/design-system/badge";
import { MoreHorizontal, Plus, X } from "lucide-react";
import { ProviderLogo } from "@/components/chat-v2/chat-input/model/provider-logo";
import type { ModelDefinition } from "@/shared/types";
import { isMCPJamProvidedModel } from "@/shared/types";
import type { EvalCase } from "./types";
import { cn } from "@/lib/utils";

/** Match compare runs: TestTemplateEditor and chat composer allow up to three models. */
const MAX_SUITE_OVERVIEW_MODELS = 3;

export type SuiteOverviewModelRow = {
  model: string;
  provider: string;
  displayName: string;
};

function compactModelLabel(name: string): string {
  return name.replace(/\s*\(Free\)\s*$/i, "").trim() || name;
}

function deriveModelsFromCases(
  testCases: EvalCase[],
  availableModels: ModelDefinition[],
): SuiteOverviewModelRow[] {
  if (!testCases.length) return [];
  const modelSet = new Map<string, SuiteOverviewModelRow>();
  for (const testCase of testCases) {
    for (const modelConfig of testCase.models ?? []) {
      const key = `${modelConfig.provider}:${modelConfig.model}`;
      if (!modelSet.has(key)) {
        const modelDef = availableModels.find(
          (m) => m.id === modelConfig.model,
        );
        modelSet.set(key, {
          model: modelConfig.model,
          provider: modelConfig.provider,
          displayName: modelDef?.name ?? modelConfig.model,
        });
      }
    }
  }
  return [...modelSet.values()].slice(0, MAX_SUITE_OVERVIEW_MODELS);
}

export interface SuiteOverviewModelBarProps {
  testCases: EvalCase[];
  availableModels: ModelDefinition[];
  readOnly?: boolean;
  onUpdate?: (models: SuiteOverviewModelRow[]) => Promise<void>;
}

export function SuiteOverviewModelBar({
  testCases,
  availableModels,
  readOnly = false,
  onUpdate,
}: SuiteOverviewModelBarProps) {
  const initialModels = useMemo(
    () => deriveModelsFromCases(testCases, availableModels),
    [testCases, availableModels],
  );

  const [models, setModels] = useState<SuiteOverviewModelRow[]>(initialModels);
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  useEffect(() => {
    setModels(initialModels);
  }, [initialModels]);

  const groupedAvailableModels = useMemo(() => {
    const grouped = new Map<string, ModelDefinition[]>();
    for (const model of availableModels) {
      const list = grouped.get(model.provider) ?? [];
      list.push(model);
      grouped.set(model.provider, list);
    }
    return grouped;
  }, [availableModels]);

  const mcpjamProviders = useMemo(() => {
    return [...groupedAvailableModels.entries()]
      .filter(([, ms]) => ms.some((m) => isMCPJamProvidedModel(m.id)))
      .sort(([a], [b]) => a.localeCompare(b));
  }, [groupedAvailableModels]);

  const userProviders = useMemo(() => {
    return [...groupedAvailableModels.entries()]
      .filter(([, ms]) => ms.some((m) => !isMCPJamProvidedModel(m.id)))
      .sort(([a], [b]) => a.localeCompare(b));
  }, [groupedAvailableModels]);

  const persist = useCallback(
    async (next: SuiteOverviewModelRow[]) => {
      if (!onUpdate) return;
      setModels(next);
      await onUpdate(next);
    },
    [onUpdate],
  );

  const handleAddModel = async (selected: ModelDefinition) => {
    if (readOnly || !onUpdate) return;
    if (models.length >= MAX_SUITE_OVERVIEW_MODELS) {
      setAddMenuOpen(false);
      return;
    }
    if (models.some((m) => m.model === selected.id)) {
      setAddMenuOpen(false);
      return;
    }
    const row: SuiteOverviewModelRow = {
      model: selected.id,
      provider: selected.provider,
      displayName: selected.name,
    };
    await persist([...models, row]);
    setAddMenuOpen(false);
  };

  const handleRemove = async (modelId: string) => {
    if (readOnly || !onUpdate || models.length <= 1) return;
    await persist(models.filter((m) => m.model !== modelId));
  };

  const handleReplaceAt = async (index: number, selected: ModelDefinition) => {
    if (readOnly || !onUpdate) return;
    if (models.some((m) => m.model === selected.id)) return;
    const next = models.map((m, i) =>
      i === index
        ? {
            model: selected.id,
            provider: selected.provider,
            displayName: selected.name,
          }
        : m,
    );
    await persist(next);
  };

  const handleMakeLead = async (index: number) => {
    if (readOnly || !onUpdate || index <= 0) return;
    const next = [...models];
    const [picked] = next.splice(index, 1);
    next.unshift(picked);
    await persist(next);
  };

  const handleKeepLeadOnly = async () => {
    if (readOnly || !onUpdate || models.length <= 1) return;
    await persist(models.slice(0, 1));
  };

  const addModelMenu = (align: "start" | "end") => (
    <DropdownMenu open={addMenuOpen} onOpenChange={setAddMenuOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/60 bg-white text-foreground transition-colors hover:bg-muted/80 dark:bg-background dark:hover:bg-muted/50"
          aria-label="Add model"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        className="w-[300px] max-h-64 overflow-y-auto"
        sideOffset={4}
      >
        {mcpjamProviders.length > 0 && (
          <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            MCPJam Free Models
          </div>
        )}
        {mcpjamProviders.map(([provider, providerModels]) => {
          const mcpjamModels = providerModels.filter((m) =>
            isMCPJamProvidedModel(m.id),
          );
          return (
            <DropdownMenuSub key={provider}>
              <DropdownMenuSubTrigger className="flex cursor-pointer items-center gap-3 text-sm">
                <ProviderLogo provider={provider} />
                <div className="flex flex-1 flex-col">
                  <span className="font-medium capitalize">{provider}</span>
                  <span className="text-xs text-muted-foreground">
                    {mcpjamModels.length} model
                    {mcpjamModels.length !== 1 ? "s" : ""}
                  </span>
                </div>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                className="max-h-[180px] min-w-[200px] overflow-y-auto"
                avoidCollisions
                collisionPadding={8}
              >
                {mcpjamModels.map((model) => (
                  <DropdownMenuItem
                    key={model.id}
                    className="flex cursor-pointer items-center gap-3 text-sm"
                    disabled={models.some((m) => m.model === model.id)}
                    onSelect={() => void handleAddModel(model)}
                  >
                    <span className="font-medium">{model.name}</span>
                    {models.some((m) => m.model === model.id) ? (
                      <Badge variant="secondary" className="text-xs">
                        Added
                      </Badge>
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        })}

        {mcpjamProviders.length > 0 && userProviders.length > 0 ? (
          <div className="my-1 h-px bg-muted/50" />
        ) : null}

        {userProviders.length > 0 && (
          <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            Your Providers
          </div>
        )}
        {userProviders.map(([provider, providerModels]) => {
          const userModels = providerModels.filter(
            (m) => !isMCPJamProvidedModel(m.id),
          );
          return (
            <DropdownMenuSub key={provider}>
              <DropdownMenuSubTrigger className="flex cursor-pointer items-center gap-3 text-sm">
                <ProviderLogo provider={provider} />
                <div className="flex flex-1 flex-col">
                  <span className="font-medium capitalize">{provider}</span>
                  <span className="text-xs text-muted-foreground">
                    {userModels.length} model
                    {userModels.length !== 1 ? "s" : ""}
                  </span>
                </div>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                className="max-h-[180px] min-w-[200px] overflow-y-auto"
                avoidCollisions
                collisionPadding={8}
              >
                {userModels.map((model) => (
                  <DropdownMenuItem
                    key={model.id}
                    className="flex cursor-pointer items-center gap-3 text-sm"
                    disabled={models.some((m) => m.model === model.id)}
                    onSelect={() => void handleAddModel(model)}
                  >
                    <span className="font-medium">{model.name}</span>
                    {models.some((m) => m.model === model.id) ? (
                      <Badge variant="secondary" className="text-xs">
                        Added
                      </Badge>
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  if (!testCases.length) {
    return null;
  }

  const editable = Boolean(onUpdate) && !readOnly;
  const canAdd =
    editable &&
    models.length < MAX_SUITE_OVERVIEW_MODELS &&
    availableModels.some((m) => !models.some((x) => x.model === m.id));

  return (
    <div className="rounded-xl bg-[#f8f5f1] py-2.5 dark:bg-muted/10">
      <div className="flex min-h-9 items-center gap-2 px-1 sm:px-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {models.length === 0 ? (
              <span className="shrink-0 text-[13px] font-normal text-[#777777] dark:text-muted-foreground">
                No models on cases yet
              </span>
            ) : null}

            {models.map((row, index) => {
              const label = compactModelLabel(row.displayName);
              return (
                <div
                  key={`${row.provider}:${row.model}`}
                  className={cn(
                    "flex h-8 max-w-[200px] shrink-0 items-center gap-1 rounded-full border px-2",
                    index === 0
                      ? "border-primary/25 bg-primary/5 text-foreground"
                      : "border-border/50 bg-muted/30 text-muted-foreground",
                  )}
                >
                  <ProviderLogo
                    provider={row.provider}
                    className="size-3.5 shrink-0"
                  />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-xs font-medium",
                      index === 0
                        ? "text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    {label}
                  </span>
                  {editable ? (
                    <>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className="shrink-0 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                            aria-label={`Model options (${label})`}
                          >
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="start"
                          className="max-h-64 w-52 overflow-y-auto"
                        >
                          {availableModels.length === 0 ? (
                            <div className="px-2 py-1.5 text-xs text-muted-foreground">
                              No models available
                            </div>
                          ) : (
                            availableModels.map((opt) => (
                              <DropdownMenuItem
                                key={opt.id}
                                disabled={models.some((m) => m.model === opt.id)}
                                onSelect={() =>
                                  void handleReplaceAt(index, opt)
                                }
                              >
                                {compactModelLabel(opt.name)}
                              </DropdownMenuItem>
                            ))
                          )}
                          {index > 0 ? (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onSelect={() => void handleMakeLead(index)}
                              >
                                Make lead model
                              </DropdownMenuItem>
                            </>
                          ) : null}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            disabled={models.length <= 1}
                            onSelect={() => void handleRemove(row.model)}
                          >
                            Remove
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                      <button
                        type="button"
                        className="shrink-0 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                        aria-label={`Remove ${label}`}
                        disabled={models.length <= 1}
                        onClick={() => void handleRemove(row.model)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </>
                  ) : null}
                </div>
              );
            })}

            {editable && canAdd ? addModelMenu("end") : null}
          </div>

          {editable && models.length > 1 ? (
            <button
              type="button"
              className="shrink-0 rounded p-1 text-[#9e9e9e] hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/10"
              aria-label="Use lead model only"
              onClick={() => void handleKeepLeadOnly()}
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
