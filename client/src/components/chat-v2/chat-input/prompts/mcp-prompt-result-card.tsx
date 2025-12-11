import { X, ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import type { MCPPromptResult } from "./mcp-prompts-popover";

interface MCPPromptResultCardProps {
  mcpPromptResult: MCPPromptResult;
  onRemove: () => void;
}

export function MCPPromptResultCard({
  mcpPromptResult,
  onRemove,
}: MCPPromptResultCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const messageCount = mcpPromptResult.result.content.messages.length;

  // Extract arguments that were used (if any)
  const usedArguments =
    mcpPromptResult.arguments?.filter((arg) => arg.required) || [];

  // Get a preview of the first message
  const getMessagePreview = () => {
    if (messageCount === 0) return null;

    const firstMessage = mcpPromptResult.result.content.messages[0];
    if (!firstMessage) return null;

    // Handle array of content blocks
    if (Array.isArray(firstMessage.content)) {
      const textBlock = firstMessage.content.find((block: any) => block?.text);
      return textBlock?.text;
    }

    // Handle single content object
    return firstMessage.content?.text;
  };

  const messagePreview = getMessagePreview();

  return (
    <div className="inline-flex flex-col rounded-md border border-border bg-muted/50 text-xs hover:bg-muted/70 transition-colors">
      {/* Compact header */}
      <div
        className="group inline-flex items-center gap-1.5 px-2 py-1 cursor-pointer"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <span className="font-small text-foreground truncate max-w-[180px]">
            {mcpPromptResult.namespacedName}
          </span>
          {messageCount > 0 && (
            <span className="text-[10px] text-muted-foreground">
              ({messageCount})
            </span>
          )}
          {isExpanded ? (
            <ChevronUp size={12} className="text-muted-foreground shrink-0" />
          ) : (
            <ChevronDown size={12} className="text-muted-foreground shrink-0" />
          )}
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="flex-shrink-0 rounded-sm opacity-60 hover:opacity-100 transition-opacity hover:bg-accent p-0.5 cursor-pointer"
          aria-label={`Remove ${mcpPromptResult.namespacedName}`}
        >
          <X size={12} className="text-muted-foreground" />
        </button>
      </div>

      {/* Expanded details */}
      {isExpanded && (
        <div className="border-t border-border px-2 py-2 space-y-2 max-w-[400px]">
          {/* Server badge */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Server:
            </span>
            <span className="text-[11px] font-mono bg-accent px-1.5 py-0.5 rounded">
              {mcpPromptResult.serverId}
            </span>
          </div>

          {/* Description */}
          {mcpPromptResult.description && (
            <div className="space-y-1">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Description:
              </span>
              <p className="text-[11px] text-foreground/80 leading-relaxed">
                {mcpPromptResult.description}
              </p>
            </div>
          )}

          {/* Arguments */}
          {usedArguments.length > 0 && (
            <div className="space-y-1">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Arguments:
              </span>
              <div className="flex flex-wrap gap-1">
                {usedArguments.map((arg) => (
                  <span
                    key={arg.name}
                    className="text-[11px] font-mono bg-primary/10 text-primary px-1.5 py-0.5 rounded"
                  >
                    {arg.name}
                    {arg.required && <span className="text-primary/60">*</span>}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Message preview */}
          {messagePreview && (
            <div className="space-y-1">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Preview:
              </span>
              <p className="text-[11px] text-foreground/70 leading-relaxed line-clamp-3 italic">
                {messagePreview}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
