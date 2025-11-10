import { useState } from "react";
import { Check, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import type { OpenRouterModel } from "@/types/model-metadata";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getProviderLogo, getProviderColor } from "@/lib/provider-logos";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { ModelDetailsModal } from "./model-details-modal";

interface ModelCardProps {
  model: OpenRouterModel;
  isSelected: boolean;
  onSelect: (model: OpenRouterModel) => void;
}

/**
 * Format large numbers with K/M/B suffix
 */
function formatNumber(num: number): string {
  if (num >= 1_000_000_000) {
    return `${(num / 1_000_000_000).toFixed(1)}B`;
  }
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(1)}M`;
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(1)}K`;
  }
  return num.toString();
}

/**
 * Format pricing string to be more readable
 */
function formatPrice(price: string): string {
  const numPrice = parseFloat(price);
  if (numPrice === 0) return "$0";
  if (numPrice < 0.01) return `$${(numPrice * 1000000).toFixed(2)}/M`;
  return `$${numPrice}/M`;
}

/**
 * Extract provider name from model ID (e.g., "openai/gpt-5" -> "OpenAI")
 */
function getProviderFromId(modelId: string): string {
  const parts = modelId.split("/");
  if (parts.length < 2) return "";

  const provider = parts[0];
  const providerMap: Record<string, string> = {
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google",
    meta: "Meta",
    "x-ai": "xAI",
    moonshotai: "Moonshot AI",
    "z-ai": "Zhipu AI",
    "meta-llama": "Meta",
  };

  return providerMap[provider] || provider;
}

export function ModelCard({ model, isSelected, onSelect }: ModelCardProps) {
  const [showDetails, setShowDetails] = useState(false);
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const providerName = getProviderFromId(model.id);
  const providerKey = model.id.split("/")[0]; // e.g., "openai", "anthropic"
  const logoSrc = getProviderLogo(providerKey, themeMode);
  const contextTokens = formatNumber(model.context_length);
  const inputPrice = formatPrice(model.pricing.prompt);
  const outputPrice = formatPrice(model.pricing.completion);

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
                  getProviderColor(providerKey),
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
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowDetails(true);
              }}
              className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors"
              aria-label="View model details"
            >
              <Info className="h-3.5 w-3.5" />
            </button>
          </div>
          {providerName && (
            <p className="text-xs text-muted-foreground">by {providerName}</p>
          )}
        </div>

        {/* Description */}
        <p className="line-clamp-2 text-sm text-muted-foreground">
          {model.description}
        </p>

        {/* Metadata badges */}
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="text-xs">
            {contextTokens} tokens
          </Badge>

          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="text-xs">
                {inputPrice} input
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p className="text-xs">Input token price per million tokens</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="text-xs">
                {outputPrice} output
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p className="text-xs">Output token price per million tokens</p>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <ModelDetailsModal
        model={model}
        open={showDetails}
        onOpenChange={setShowDetails}
      />
    </button>
  );
}
