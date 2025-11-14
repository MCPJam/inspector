import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ModelDefinition } from "@/shared/types";
import { Badge } from "@/components/ui/badge";
import { getProviderLogo, getProviderColor } from "@/lib/provider-logos";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

interface UserModelCardProps {
  model: ModelDefinition;
  isSelected: boolean;
  onSelect: (model: ModelDefinition) => void;
}

/**
 * Get provider display name
 */
function getProviderDisplayName(provider: string): string {
  const providerMap: Record<string, string> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    deepseek: "DeepSeek",
    google: "Google AI",
    mistral: "Mistral AI",
    ollama: "Ollama",
    meta: "Meta",
    xai: "xAI",
    litellm: "LiteLLM",
    moonshotai: "Moonshot AI",
    "z-ai": "Zhipu AI",
    openrouter: "OpenRouter",
  };

  return providerMap[provider] || provider;
}

export function UserModelCard({
  model,
  isSelected,
  onSelect,
}: UserModelCardProps) {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const providerName = getProviderDisplayName(model.provider);
  const logoSrc = getProviderLogo(model.provider, themeMode);

  return (
    <button
      type="button"
      onClick={() => onSelect(model)}
      className={cn(
        "group relative w-full rounded-lg border text-left transition-all duration-200",
        "hover:border-primary/50 hover:shadow-md",
        isSelected
          ? "border-primary bg-primary/5 shadow-md"
          : "border-border bg-background",
      )}
    >
      {/* Selection indicator */}
      {isSelected && (
        <div className="absolute right-3 top-3">
          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-primary">
            <Check className="h-3 w-3 text-primary-foreground" />
          </div>
        </div>
      )}

      <div className="space-y-3 p-4">
        {/* Header */}
        <div className="space-y-1 pr-8">
          <div className="flex items-center gap-2">
            {logoSrc ? (
              <img
                src={logoSrc}
                alt={`${providerName} logo`}
                className="h-4 w-4 object-contain flex-shrink-0"
              />
            ) : (
              <div
                className={cn(
                  "h-4 w-4 rounded-sm flex items-center justify-center flex-shrink-0",
                  getProviderColor(model.provider),
                )}
              >
                <span className="text-white font-bold text-[8px]">
                  {providerName?.charAt(0) || "?"}
                </span>
              </div>
            )}
            <h3 className="font-semibold text-foreground line-clamp-1">
              {model.name}
            </h3>
          </div>
          <p className="text-xs text-muted-foreground">by {providerName}</p>
        </div>
      </div>
    </button>
  );
}
