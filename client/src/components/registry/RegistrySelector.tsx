import { useState } from "react";
import { useRegistrySourcesStore } from "@/stores/registry/registry-sources-store";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Lock, Plus, Trash2 } from "lucide-react";
import { AddRegistryDialog } from "./AddRegistryDialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface RegistrySelectorProps {
  onRegistryChange?: (registryUrl: string) => void;
}

export function RegistrySelector({ onRegistryChange }: RegistrySelectorProps) {
  const { sources, activeSourceId, setActiveSource, removeSource } =
    useRegistrySourcesStore();
  const [showAddDialog, setShowAddDialog] = useState(false);

  const handleValueChange = (value: string) => {
    if (value === "__add__") {
      setShowAddDialog(true);
      return;
    }
    setActiveSource(value);
    const source = sources.find((s) => s.id === value);
    if (source && onRegistryChange) {
      onRegistryChange(source.url);
    }
  };

  const handleRemoveSource = (
    e: React.MouseEvent,
    sourceId: string,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    removeSource(sourceId);
  };

  const activeSource = sources.find((s) => s.id === activeSourceId);

  return (
    <>
      <Select value={activeSourceId} onValueChange={handleValueChange}>
        <SelectTrigger className="w-[200px]">
          <SelectValue placeholder="Select registry">
            {activeSource && (
              <span className="flex items-center gap-2">
                {activeSource.name}
                {activeSource.requiresAuth && (
                  <Lock className="h-3 w-3 text-muted-foreground" />
                )}
              </span>
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {sources.map((source) => (
            <SelectItem key={source.id} value={source.id}>
              <div className="flex items-center justify-between w-full gap-2">
                <span className="flex items-center gap-2">
                  {source.name}
                  {source.requiresAuth && (
                    <Lock className="h-3 w-3 text-muted-foreground" />
                  )}
                </span>
                {!source.isOfficial && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 w-5 p-0 hover:bg-destructive/10"
                        onClick={(e) => handleRemoveSource(e, source.id)}
                      >
                        <Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Remove registry</TooltipContent>
                  </Tooltip>
                )}
              </div>
            </SelectItem>
          ))}
          <SelectSeparator />
          <SelectItem value="__add__">
            <span className="flex items-center gap-2 text-muted-foreground">
              <Plus className="h-4 w-4" />
              Add Registry
            </span>
          </SelectItem>
        </SelectContent>
      </Select>

      <AddRegistryDialog
        open={showAddDialog}
        onOpenChange={setShowAddDialog}
        onRegistryAdded={(registryUrl) => {
          if (onRegistryChange) {
            onRegistryChange(registryUrl);
          }
        }}
      />
    </>
  );
}
