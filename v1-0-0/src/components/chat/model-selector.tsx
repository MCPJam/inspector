"use client";

import { useState } from "react";
import { ChevronDown, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

interface ModelOption {
  id: string;
  name: string;
  provider: string;
}

interface ModelSelectorProps {
  currentModel: string;
  availableModels: ModelOption[];
  onModelChange: (model: string) => void;
  disabled?: boolean;
  className?: string;
}

export function ModelSelector({
  currentModel,
  availableModels,
  onModelChange,
  disabled = false,
  className,
}: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);

  const currentModelData = availableModels.find(m => m.id === currentModel);
  const displayName = currentModelData?.name || "Select Model";

  const getProviderColor = (provider: string) => {
    switch (provider) {
      case "anthropic":
        return "text-orange-600 dark:text-orange-400";
      case "openai":
        return "text-green-600 dark:text-green-400";
      default:
        return "text-blue-600 dark:text-blue-400";
    }
  };

  if (availableModels.length === 0) {
    return (
      <div className={cn(
        "flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground bg-muted/50 rounded-md",
        className
      )}>
        <Zap className="h-3 w-3" />
        <span>No API keys</span>
      </div>
    );
  }

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          className={cn(
            "h-7 px-2 text-xs font-medium border border-border/50 hover:border-border",
            "bg-background/80 hover:bg-background",
            "text-foreground/80 hover:text-foreground",
            className
          )}
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <Zap className={cn(
              "h-3 w-3 shrink-0",
              currentModelData ? getProviderColor(currentModelData.provider) : "text-muted-foreground"
            )} />
            <span className="truncate max-w-[120px]">{displayName}</span>
            <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
          </div>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[180px]">
        {availableModels.map((model) => (
          <DropdownMenuItem
            key={model.id}
            onClick={() => {
              onModelChange(model.id);
              setIsOpen(false);
            }}
            className="flex items-center gap-2 text-sm"
          >
            <Zap className={cn("h-3 w-3", getProviderColor(model.provider))} />
            <div className="flex flex-col">
              <span className="font-medium">{model.name}</span>
              <span className="text-xs text-muted-foreground capitalize">
                {model.provider}
              </span>
            </div>
            {model.id === currentModel && (
              <div className="ml-auto w-1.5 h-1.5 bg-primary rounded-full" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}