import { X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import type { OpenRouterModel } from "@/types/model-metadata";
import { getProviderLogo } from "@/lib/provider-logos";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

interface ModelDetailsModalProps {
  model: OpenRouterModel;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Format large numbers with K/M/B suffix
 */
function formatNumber(num: number | null | undefined): string {
  if (num == null || isNaN(num)) {
    return "N/A";
  }
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
  if (numPrice < 0.01)
    return `$${(numPrice * 1000000).toFixed(2)} per 1M tokens`;
  return `$${numPrice} per 1M tokens`;
}

/**
 * Extract provider name from model ID
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
    "meta-llama": "Meta",
    "x-ai": "xAI",
    moonshotai: "Moonshot AI",
    "z-ai": "Zhipu AI",
  };

  return providerMap[provider] || provider;
}

export function ModelDetailsModal({
  model,
  open,
  onOpenChange,
}: ModelDetailsModalProps) {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const providerName = getProviderFromId(model.id);
  const providerKey = model.id.split("/")[0];
  const logoSrc = getProviderLogo(providerKey, themeMode);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] w-full max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            {logoSrc && (
              <img
                src={logoSrc}
                alt={`${providerName} logo`}
                className="h-6 w-6 object-contain"
              />
            )}
            <span>{model.name}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Provider Info */}
          <div>
            <h4 className="text-sm font-medium text-muted-foreground mb-2">
              Provider
            </h4>
            <p className="text-base">{providerName}</p>
          </div>

          <Separator />

          {/* Description */}
          <div>
            <h4 className="text-sm font-medium text-muted-foreground mb-2">
              Description
            </h4>
            <p className="text-sm leading-relaxed">{model.description}</p>
          </div>

          <Separator />

          {/* Context & Tokens */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <h4 className="text-sm font-medium text-muted-foreground mb-2">
                Context Length
              </h4>
              <p className="text-base font-semibold">
                {formatNumber(model.context_length)} tokens
              </p>
            </div>
            <div>
              <h4 className="text-sm font-medium text-muted-foreground mb-2">
                Max Completion Tokens
              </h4>
              <p className="text-base font-semibold">
                {formatNumber(model.top_provider.max_completion_tokens)} tokens
              </p>
            </div>
          </div>

          <Separator />

          {/* Pricing */}
          <div>
            <h4 className="text-sm font-medium text-muted-foreground mb-3">
              Pricing
            </h4>
            <div className="space-y-2">
              <div className="flex items-center justify-between rounded-md bg-muted/30 p-3">
                <span className="text-sm">Input</span>
                <span className="font-medium">
                  {formatPrice(model.pricing.prompt)}
                </span>
              </div>
              <div className="flex items-center justify-between rounded-md bg-muted/30 p-3">
                <span className="text-sm">Output</span>
                <span className="font-medium">
                  {formatPrice(model.pricing.completion)}
                </span>
              </div>
              {parseFloat(model.pricing.image) > 0 && (
                <div className="flex items-center justify-between rounded-md bg-muted/30 p-3">
                  <span className="text-sm">Image</span>
                  <span className="font-medium">
                    {formatPrice(model.pricing.image)}
                  </span>
                </div>
              )}
              {parseFloat(model.pricing.request) > 0 && (
                <div className="flex items-center justify-between rounded-md bg-muted/30 p-3">
                  <span className="text-sm">Per Request</span>
                  <span className="font-medium">${model.pricing.request}</span>
                </div>
              )}
            </div>
          </div>

          <Separator />

          {/* Architecture */}
          <div>
            <h4 className="text-sm font-medium text-muted-foreground mb-3">
              Architecture
            </h4>
            <div className="space-y-3">
              <div>
                <span className="text-sm text-muted-foreground">Modality:</span>
                <span className="ml-2 text-sm font-medium">
                  {model.architecture.modality}
                </span>
              </div>
              {model.architecture.tokenizer && (
                <div>
                  <span className="text-sm text-muted-foreground">
                    Tokenizer:
                  </span>
                  <span className="ml-2 text-sm font-medium">
                    {model.architecture.tokenizer}
                  </span>
                </div>
              )}
              {model.architecture.instruct_type && (
                <div>
                  <span className="text-sm text-muted-foreground">
                    Instruct Type:
                  </span>
                  <span className="ml-2 text-sm font-medium">
                    {model.architecture.instruct_type}
                  </span>
                </div>
              )}
            </div>
          </div>

          <Separator />

          {/* Input/Output Modalities */}
          {(model.architecture.input_modalities?.length > 0 ||
            model.architecture.output_modalities?.length > 0) && (
            <>
              <div>
                <h4 className="text-sm font-medium text-muted-foreground mb-3">
                  Supported Modalities
                </h4>
                <div className="space-y-3">
                  {model.architecture.input_modalities?.length > 0 && (
                    <div>
                      <p className="text-sm text-muted-foreground mb-2">
                        Input:
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {model.architecture.input_modalities.map((modality) => (
                          <Badge key={modality} variant="secondary">
                            {modality}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {model.architecture.output_modalities?.length > 0 && (
                    <div>
                      <p className="text-sm text-muted-foreground mb-2">
                        Output:
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {model.architecture.output_modalities.map(
                          (modality) => (
                            <Badge key={modality} variant="secondary">
                              {modality}
                            </Badge>
                          ),
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
              <Separator />
            </>
          )}

          {/* Supported Parameters */}
          {model.supported_parameters?.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-muted-foreground mb-3">
                Supported Parameters
              </h4>
              <div className="flex flex-wrap gap-2">
                {model.supported_parameters.map((param) => (
                  <Badge key={param} variant="outline">
                    {param}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Model ID */}
          <div className="rounded-md bg-muted/30 p-3">
            <p className="text-xs text-muted-foreground mb-1">Model ID</p>
            <code className="text-xs font-mono">{model.id}</code>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
