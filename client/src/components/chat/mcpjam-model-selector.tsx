import { useEffect, useMemo, useState } from "react";
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
  onModelChange: (model: ModelDefinition) => void;
  desiredModelId?: string | null;
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

function toDisplayName(
  provider: string,
  names?: Record<string, string>,
): string {
  return names?.[provider] || PROVIDER_DISPLAY_NAME[provider] || provider;
}

export function MCPJamModelSelector({
  currentModel,
  onModelChange,
  desiredModelId,
  disabled,
  isLoading,
  providerNames,
}: MCPJamModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [models, setModels] = useState<ModelDefinition[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

  // Fetch providers and models from OpenRouter to populate selector
  useEffect(() => {
    let cancelled = false;
    async function fetchModels() {
      try {
        setLoading(true);
        const [provRes, modRes] = await Promise.all([
          fetch("https://openrouter.ai/api/v1/providers"),
          fetch("https://openrouter.ai/api/v1/models"),
        ]);
        await provRes.json().catch(() => ({ data: [] }));
        const modJson = await modRes.json().catch(() => ({ data: [] }));
        if (cancelled) return;
        const mapped: ModelDefinition[] = (
          Array.isArray(modJson?.data) ? modJson.data : []
        )
          .map((m: any) => {
            const id = m?.id || m?.canonical_slug || m?.name;
            const name = m?.name || String(id);
            const provider = String(id || "").includes("/")
              ? String(id).split("/")[0]
              : m?.canonical_slug?.split("/")?.[0] || "openrouter";
            return { id, name, provider: provider as any } as ModelDefinition;
          })
          .filter((m: ModelDefinition) => !!m.id && !!m.name);
        setModels(mapped);
        // Auto-select if not set
        if (!currentModel) {
          const target = desiredModelId
            ? mapped.find((m) => m.id === desiredModelId) || null
            : mapped[0] || null;
          if (target) onModelChange(target);
        }
      } finally {
        setLoading(false);
      }
    }
    fetchModels();
    return () => {
      cancelled = true;
    };
  }, []);

  // When desiredModelId changes, try to select it if different
  useEffect(() => {
    if (!desiredModelId) return;
    if (currentModel?.id === desiredModelId) return;
    // Prefer exact id match
    const exact = models.find((m) => String(m.id) === String(desiredModelId));
    if (exact) {
      onModelChange(exact);
      return;
    }
    // Fallback: try to resolve by canonical id suffix (after provider/)
    const suffix = String(desiredModelId).split("/").pop();
    const bySuffix = models.find(
      (m) => String(m.id).split("/").pop() === suffix,
    );
    if (bySuffix) onModelChange(bySuffix);
  }, [desiredModelId, models]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? models.filter(
          (m) =>
            m.name.toLowerCase().includes(q) ||
            String(m.id).toLowerCase().includes(q) ||
            String(m.provider).toLowerCase().includes(q),
        )
      : models;
    const groups = new Map<ModelProvider, ProviderGroup>();
    for (const m of list) {
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
  }, [models, query]);

  const current = currentModel;

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || isLoading || loading}
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
                      <span className="text-[10px] text-muted-foreground truncate">
                        {String(m.id)}
                      </span>
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
