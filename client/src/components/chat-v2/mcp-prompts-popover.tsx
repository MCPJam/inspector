import {
  Popover,
  PopoverContent,
  PopoverAnchor,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/chat-utils";
import { MessageSquareCode, ListChecks, Loader2 } from "lucide-react";

import { useEffect, useMemo, useState, FormEvent, useCallback } from "react";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import type { MCPPrompt, MCPPromptArgument } from "@/shared/types";
import {
  listPromptsForServers,
  getPrompt,
  PromptContentResponse,
} from "@/lib/mcp-prompts-api";

export interface MCPPromptResult extends PromptListItem {
  result: PromptContentResponse;
}

interface PromptListItem extends MCPPrompt {
  namespacedName: string;
  serverId: string;
}

interface PromptsPopoverProps {
  anchor: { x: number; y: number };
  selectedServers?: string[];
  onPromptSelected: (mcpPromptResult: MCPPromptResult) => void;
  actionTrigger: string | null;
  setActionTrigger: (trigger: string | null) => void;
  value: string;
  caretIndex: number;
}

// Utility function to check if MCP prompts are requested
// Also used in chat-input.tsx to handle keydown events
export const isMCPPromptsRequested = (
  value: string,
  caretIndex: number,
): boolean => {
  const textUpToCaret = value.slice(0, caretIndex);
  // Check text up to caret position for " /" or "/" at start of line or textarea
  const isPromptsRequested = /(?:^\/$|\s+\/$)/.test(textUpToCaret);
  return isPromptsRequested;
};

export function PromptsPopover({
  anchor,
  selectedServers,
  onPromptSelected,
  actionTrigger,
  setActionTrigger,
  value,
  caretIndex,
}: PromptsPopoverProps) {
  const [open, setOpen] = useState(false);
  const [promptListItems, setPromptListItems] = useState<PromptListItem[]>([]);
  const [selectedPrompt, setSelectedPrompt] = useState<PromptListItem | null>(
    null,
  );
  const [isPromptArgsDialogOpen, setIsPromptArgsDialogOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [isHovering, setIsHovering] = useState(false);

  useEffect(() => {
    // Fetch prompts for selected servers
    let active = true;
    (async () => {
      try {
        if (!selectedServers || selectedServers.length === 0) {
          return;
        }
        const { prompts } = await listPromptsForServers(selectedServers);
        const promptListItems: PromptListItem[] = [];
        for (const serverId of Object.keys(prompts)) {
          const serverPrompts = prompts[serverId];
          serverPrompts.forEach((prompt) => {
            const namespacedName = `${serverId}/${prompt.name}`;
            promptListItems.push({
              ...prompt,
              namespacedName,
              serverId,
              isLoading: false,
            });
          });
        }
        if (!active) return;
        setPromptListItems(promptListItems);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[PromptsPopover] Failed to fetch prompts", message);
      }
    })();
    return () => {
      active = false;
    };
  }, [selectedServers]);

  const getPromptResult = useCallback(
    async (promptListItem: PromptListItem, values: Record<string, string>) => {
      try {
        const { serverId, name: promptName } = promptListItem;
        const response = await getPrompt(serverId, promptName, values);
        const promptResult: MCPPromptResult = {
          ...promptListItem,
          result: response,
        };
        onPromptSelected(promptResult);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[PromptsPopover] Failed to get prompt result", message);
      } finally {
        setSelectedPrompt(null);
      }
    },
    [onPromptSelected],
  );

  useEffect(() => {
    // Handle prompt click
    (async () => {
      if (!selectedPrompt) {
        return;
      }
      if (selectedPrompt.arguments && selectedPrompt.arguments.length > 0) {
        setIsPromptArgsDialogOpen(true);
        return;
      }
      const EMPTY_ARGS = {};
      await getPromptResult(selectedPrompt, EMPTY_ARGS);
    })();
  }, [selectedPrompt, getPromptResult]);

  useEffect(() => {
    // Handle key press events from textarea
    try {
      if (actionTrigger === null) return;

      if (actionTrigger === "ArrowDown") {
        setHighlightedIndex((prev) => (prev + 1) % promptListItems.length);
      } else if (actionTrigger === "ArrowUp") {
        setHighlightedIndex(
          (prev) =>
            (prev - 1 + promptListItems.length) % promptListItems.length,
        );
      } else if (actionTrigger === "Enter") {
        if (highlightedIndex === -1) return;
        setIsHovering(false);
        setSelectedPrompt(promptListItems[highlightedIndex]);
      } else if (actionTrigger === "Escape") {
        setOpen(false);
      }
    } finally {
      setActionTrigger(null);
    }
  }, [actionTrigger]);

  useEffect(() => {
    // Open popover if prompts are requested
    setOpen(
      isMCPPromptsRequested(value, caretIndex) && promptListItems.length > 0,
    );
  }, [value, caretIndex]);

  const onCancelPromptArgsDialog = () => {
    setIsPromptArgsDialogOpen(false);
    setSelectedPrompt(null);
  };

  return (
    <div className="relative">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          {/* Invisible anchor for dropdown positioning */}
          <span
            style={{
              position: "absolute",
              left: anchor.x,
              top: anchor.y,
              width: 0,
              height: 0,
              zIndex: 1,
              pointerEvents: "none",
            }}
          />
        </PopoverAnchor>

        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={16}
          onMouseEnter={() => setIsHovering(true)}
          onMouseLeave={() => setIsHovering(false)}
          onOpenAutoFocus={(event) => event.preventDefault()}
          className="w-auto min-w-[200px] p-1"
        >
          <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            SELECT A PROMPT
          </div>
          <div className="flex flex-col">
            {promptListItems.map((prompt, index) => (
              <Tooltip key={prompt.namespacedName} delayDuration={1000}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      "flex items-center gap-2 rounded-sm px-2 max-w-[300px] py-1.5 text-xs select-none hover:bg-accent hover:text-accent-foreground",
                      highlightedIndex === index
                        ? "bg-accent text-accent-foreground"
                        : "",
                    )}
                    onClick={() => setSelectedPrompt(prompt)}
                    onMouseEnter={() => {
                      if (isHovering) {
                        setHighlightedIndex(index);
                      }
                    }}
                  >
                    <MessageSquareCode size={16} className="shrink-0" />
                    <span className="flex-1 text-left truncate">
                      {prompt.namespacedName}
                    </span>
                    {prompt.namespacedName ===
                    selectedPrompt?.namespacedName ? (
                      <Loader2
                        size={14}
                        className="text-muted-foreground shrink-0 ml-2 animate-spin"
                        aria-label="Loading"
                      />
                    ) : prompt.arguments && prompt.arguments.length > 0 ? (
                      <ListChecks
                        size={14}
                        className="text-muted-foreground shrink-0 ml-2"
                        aria-label="Requires inputs"
                      />
                    ) : null}
                  </button>
                </TooltipTrigger>
                <TooltipContent>{prompt.description}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      <PromptsArgumentsDialog
        open={isPromptArgsDialogOpen}
        onOpenChange={setIsPromptArgsDialogOpen}
        promptListItem={selectedPrompt}
        onSubmit={getPromptResult}
        onCancel={onCancelPromptArgsDialog}
      />
    </div>
  );
}

interface PromptsArgumentsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  promptListItem: PromptListItem | null;
  onSubmit: (
    promptListItem: PromptListItem,
    values: Record<string, string>,
  ) => Promise<void>;
  onCancel: () => void;
}

interface ArgumentField extends MCPPromptArgument {
  value: string;
}

export function PromptsArgumentsDialog({
  open,
  onOpenChange,
  promptListItem,
  onSubmit,
  onCancel,
}: PromptsArgumentsDialogProps) {
  const [fields, setFields] = useState<ArgumentField[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    // Reset state when dialog closes
    if (!open) {
      setIsLoading(false);
      return;
    }

    // Set fields from prompt list item arguments when dialog opens
    if (!promptListItem?.arguments || promptListItem.arguments.length === 0) {
      return;
    }
    setFields(
      promptListItem.arguments.map((arg) => ({
        ...arg,
        value: "",
      })),
    );
  }, [open, promptListItem?.arguments]);

  const handleFieldChange = (name: string, value: string) => {
    setFields((prev) =>
      prev.map((field) => (field.name === name ? { ...field, value } : field)),
    );
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!promptListItem) return;
    const values: Record<string, string> = {};
    fields.forEach((field) => {
      values[field.name] = field.value;
    });
    setIsLoading(true);
    try {
      await onSubmit(promptListItem, values);
    } finally {
      if (open) {
        setIsLoading(false);
        onOpenChange(false);
      }
    }
  };

  const isSubmitDisabled = useMemo(() => {
    const missingRequired = fields.some(
      (field) => field.required && !field.value.trim(),
    );
    return missingRequired || isLoading;
  }, [fields, isLoading]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{`Arguments for ${promptListItem?.namespacedName}`}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-6">
          {fields.map((field) => (
            <div key={field.name} className="space-y-2">
              <div className="flex items-center justify-between">
                <label
                  htmlFor={`prompt-arg-${field.name}`}
                  className="text-sm font-medium"
                >
                  {field.name}
                </label>
                {field.required && (
                  <span className="text-[11px] uppercase tracking-wide text-primary">
                    Required
                  </span>
                )}
              </div>
              <Input
                id={`prompt-arg-${field.name}`}
                value={field.value}
                placeholder={field.description || "Enter a value"}
                onChange={(event) =>
                  handleFieldChange(field.name, event.target.value)
                }
                className="h-10"
              />
              {field.description && (
                <p className="text-xs text-muted-foreground">
                  {field.description}
                </p>
              )}
            </div>
          ))}
          <div className="flex justify-end space-x-2 pt-4">
            <Button
              type="button"
              variant="outline"
              className="px-4"
              onClick={() => onCancel()}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitDisabled} className="px-4">
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading...
                </>
              ) : (
                "Done"
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// utils
export const mcpPromptResultsToText = (mcpPromptResults: MCPPromptResult[]) => {
  if (mcpPromptResults.length === 0) return "";

  return mcpPromptResults
    .map((result) => {
      const messages = result.result.content.messages
        .map((message: any) => {
          // Handle array of content blocks
          if (Array.isArray(message.content)) {
            return message.content
              .map((block: any) => block?.text)
              .filter(Boolean)
              .join("\n");
          }
          // Handle single content object
          return message.content?.text;
        })
        .filter(Boolean)
        .join("\n\n");

      if (!messages) return "";

      // Include prompt name as header
      return `[${result.namespacedName}]\n\n${messages}\n\n`;
    })
    .filter(Boolean)
    .join("\n\n");
};
