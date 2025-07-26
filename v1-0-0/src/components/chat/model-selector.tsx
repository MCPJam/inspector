"use client";

import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Model, ModelDefinition } from "@/lib/types";
import { ProviderLogo } from "./provider-logo";

interface ModelSelectorProps {
  currentModel: Model;
  availableModels: ModelDefinition[];
  onModelChange: (model: Model) => void;
  disabled?: boolean;
  isLoading?: boolean;
}

export function ModelSelector({
  currentModel,
  availableModels,
  onModelChange,
  disabled,
  isLoading,
}: ModelSelectorProps) {
  const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false);
  const currentModelData = availableModels.find((m) => m.id === currentModel);

  if (!currentModelData) {
    return null;
  }

  return (
    <DropdownMenu
      open={isModelSelectorOpen}
      onOpenChange={setIsModelSelectorOpen}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || isLoading}
          className="h-8 px-2 rounded-full hover:bg-muted/80 transition-colors text-xs cursor-pointer"
        >
          <>
            <ProviderLogo provider={currentModelData.provider} />
            <span className="text-[10px] font-medium">
              {currentModelData.name}
            </span>
          </>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[200px]">
        {availableModels.map((model) => (
          <DropdownMenuItem
            key={model.id}
            onClick={() => {
              onModelChange(model.id);
              setIsModelSelectorOpen(false);
            }}
            className="flex items-center gap-3 text-sm cursor-pointer"
          >
            <ProviderLogo
              provider={model.provider}
            />
            <div className="flex flex-col">
              <span className="font-medium">{model.name}</span>
              <span className="text-xs text-muted-foreground capitalize">
                {model.provider}
              </span>
            </div>
            {model.id === currentModel && (
              <div className="ml-auto w-2 h-2 bg-primary rounded-full" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
