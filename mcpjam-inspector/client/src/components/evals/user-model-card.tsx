import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ModelDefinition } from "@/shared/types";
import { getProviderDisplayName } from "@/lib/provider-registry";
import { ProviderLogo } from "@/components/chat-v2/chat-input/model/provider-logo";

interface UserModelCardProps {
  model: ModelDefinition;
  isSelected: boolean;
  onSelect: (model: ModelDefinition) => void;
}

export function UserModelCard({
  model,
  isSelected,
  onSelect,
}: UserModelCardProps) {
  // For a custom provider the configured name lives in `customProviderName`;
  // pass the `custom:<slug>` group-key form so it (not "Custom") is shown.
  const providerName = getProviderDisplayName(
    model.provider === "custom" && model.customProviderName
      ? `custom:${model.customProviderName}`
      : model.provider,
  );

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
            <ProviderLogo
              provider={model.provider}
              customProviderName={model.customProviderName}
              className="h-4 w-4 shrink-0"
              letterClassName="text-[8px]"
            />
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
