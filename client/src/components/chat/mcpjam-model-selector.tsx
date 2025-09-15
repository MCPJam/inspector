import { useMemo, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ProviderLogo } from "./provider-logo";
import type { ModelDefinition, ModelProvider } from "@/shared/types.js";

interface MCPJamModelSelectorProps {
  currentModel: ModelDefinition | null;
  availableModels: ModelDefinition[];
  onModelChange: (model: ModelDefinition) => void;
  disabled?: boolean;
  isLoading?: boolean;
  providerNames?: Record<string, string>;
}

type ProviderGroup = {
  provider: ModelProvider;
  displayName: string;
  models: ModelDefinition[];
};

const PROVIDER_DISPLAY_NAME: Partial<Record<string, string>> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google AI",
  deepseek: "DeepSeek",
};

function toDisplayName(provider: string, names?: Record<string, string>): string {
  return names?.[provider] || PROVIDER_DISPLAY_NAME[provider] || provider;
}

export function MCPJamModelSelector({
  currentModel,
  availableModels,
  onModelChange,
  disabled,
  isLoading,
  providerNames,
}: MCPJamModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const models = q
      ? availableModels.filter(
          (m) =>
            m.name.toLowerCase().includes(q) ||
            String(m.id).toLowerCase().includes(q) ||
            String(m.provider).toLowerCase().includes(q),
        )
      : availableModels;
    const groups = new Map<ModelProvider, ProviderGroup>();
    for (const m of models) {
      const key = m.provider as ModelProvider;
      const group = groups.get(key) || {
        provider: key,
        displayName: toDisplayName(key, providerNames),
        models: [],
      };
      group.models.push(m);
      groups.set(key, group);
    }
    return Array.from(groups.values()).sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    );
  }, [availableModels, query]);

  const current = currentModel;

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || isLoading}
          className="h-8 px-2 rounded-full hover:bg-muted/80 transition-colors text-xs cursor-pointer"
        >
          {current ? (
            <>
              <ProviderLogo provider={current.provider} />
              <span className="text-[10px] font-medium ml-2">
                {current.name}
              </span>
              <Badge variant="secondary" className="ml-2 text-[9px]">
                {toDisplayName(current.provider, providerNames)}
              </Badge>
            </>
          ) : (
            <span className="text-[10px]">Select a model</span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[260px] p-0">
        <div className="p-2 border-b border-border">
          <Input
            placeholder="Search models or providers"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-7 text-xs"
          />
        </div>
        {filtered.length === 0 ? (
          <div className="p-3 text-[11px] text-muted-foreground">No models</div>
        ) : (
          filtered.map((group) => (
            <DropdownMenuSub key={group.provider}>
              <DropdownMenuSubTrigger className="flex items-center gap-3 text-xs cursor-pointer">
                <ProviderLogo provider={group.provider} />
                <div className="flex items-center gap-2">
                  <span className="font-medium">{group.displayName}</span>
                  <Badge variant="secondary" className="text-[9px]">
                    {group.models.length}
                  </Badge>
                </div>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-[260px] max-h-[260px] overflow-y-auto">
                {group.models.map((m) => (
                  <DropdownMenuItem
                    key={m.id}
                    onSelect={() => {
                      onModelChange(m);
                      setIsOpen(false);
                    }}
                    className="flex items-center gap-3 text-xs cursor-pointer"
                  >
                    <div className="flex flex-col min-w-0">
                      <span className="font-medium truncate">{m.name}</span>
                      <span className="text-[10px] text-muted-foreground truncate">{String(m.id)}</span>
                    </div>
                    {current && m.id === current.id && (
                      <div className="ml-auto w-2 h-2 bg-primary rounded-full" />
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default MCPJamModelSelector;


