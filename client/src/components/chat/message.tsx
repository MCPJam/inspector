
import { memo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { formatTimestamp, sanitizeText } from "@/lib/chat-utils";
import { ChatMessage } from "@/lib/chat-types";
import { Copy, CopyIcon, RotateCcw } from "lucide-react";
import { Markdown } from "./markdown";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { MessageEditor } from "./message-editor";
import { ToolCallDisplay } from "./tool-call";
import { getProviderLogoFromModel } from "./chat-helpers";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { ModelDefinition } from "@/lib/types";

interface MessageProps {
  message: ChatMessage;
  isLoading?: boolean;
  onEdit?: (messageId: string, newContent: string) => void;
  onRegenerate?: (messageId: string) => void;
  onCopy?: (content: string) => void;
  isReadonly?: boolean;
  showActions?: boolean;
  model: ModelDefinition | null;
}

// Thinking indicator component
const ThinkingIndicator = () => (
  <div className="flex items-center gap-2 py-2">
    <span className="text-sm text-muted-foreground">Thinking</span>
    <div className="flex space-x-1">
      <div className="w-1.5 h-1.5 bg-muted-foreground/60 rounded-full animate-bounce" />
      <div className="w-1.5 h-1.5 bg-muted-foreground/60 rounded-full animate-bounce [animation-delay:-0.2s]" />
      <div className="w-1.5 h-1.5 bg-muted-foreground/60 rounded-full animate-bounce [animation-delay:-0.4s]" />
    </div>
  </div>
);

const PureMessage = ({
  message,
  isLoading = false,
  onEdit,
  onRegenerate,
  onCopy,
  isReadonly = false,
  showActions = true,
  model,
}: MessageProps) => {
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [isHovered, setIsHovered] = useState(false);
  const themeMode = usePreferencesStore((s) => s.themeMode);

  const handleCopy = () => {
    if (onCopy) {
      onCopy(message.content);
    } else {
      navigator.clipboard.writeText(message.content);
    }
  };

  const handleEdit = () => {
    setMode("edit");
  };

  const handleSaveEdit = (newContent: string) => {
    if (onEdit) {
      onEdit(message.id, newContent);
    }
    setMode("view");
  };

  const handleCancelEdit = () => {
    setMode("view");
  };

  const handleRegenerate = () => {
    if (onRegenerate) {
      onRegenerate(message.id);
    }
  };

  // Check if we should show thinking indicator for assistant messages
  const shouldShowThinking =
    message.role === "assistant" &&
    isLoading &&
    (!message.content || message.content.trim() === "");

  return (
    <AnimatePresence>
      <motion.div
        data-testid={`message-${message.role}`}
        className="w-full mx-auto max-w-4xl px-4 group/message"
        initial={{ y: 5, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        data-role={message.role}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Assistant Messages - Left aligned with avatar */}
        {message.role === "assistant" && (
          <div className="flex gap-4 w-full">
            <div className="size-8 flex items-center rounded-full justify-center shrink-0 bg-muted/50">
              <img
                src={getProviderLogoFromModel(model!, themeMode)!}
                alt={`${model?.id} logo`}
                className="h-4 w-4 object-contain"
              />
            </div>

            {/* Assistant Message Content */}
            <div className="flex flex-col gap-4 w-full min-w-0">
              {/* Attachments */}
              {message.attachments && message.attachments.length > 0 && (
                <div className="flex flex-row gap-2">
                  {message.attachments.map((attachment) => (
                    <div
                      key={attachment.id}
                      className="px-3 py-2 bg-muted rounded-lg text-sm"
                    >
                      {attachment.name}
                    </div>
                  ))}
                </div>
              )}

              {/* Tool Calls */}
              {message.toolCalls && message.toolCalls.length > 0 && (
                <div className="space-y-2">
                  {message.toolCalls.map((toolCall) => {
                    const toolResult = message.toolResults?.find(
                      (tr) => tr.toolCallId === toolCall.id,
                    );
                    return (
                      <ToolCallDisplay
                        key={toolCall.id}
                        toolCall={toolCall}
                        toolResult={toolResult}
                      />
                    );
                  })}
                </div>
              )}

              {/* Assistant Message Text or Thinking Indicator */}
              {shouldShowThinking ? (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.3 }}
                >
                  <ThinkingIndicator />
                </motion.div>
              ) : mode === "view" ? (
                <div className="relative">
                  <div
                    data-testid="message-content"
                    className="prose prose-sm max-w-none dark:prose-invert prose-p:leading-relaxed prose-pre:bg-muted/50 prose-pre:border prose-pre:border-border/30 flex-1 min-w-0"
                  >
                    <Markdown>{sanitizeText(message.content)}</Markdown>
                  </div>

                  {/* Timestamp and Actions - Absolute positioned below message */}
                  {isHovered && (
                    <div className="absolute -bottom-6 left-0 right-0 flex items-center justify-between">
                      <div className="text-xs text-muted-foreground/60">
                        {formatTimestamp(message.timestamp)}
                      </div>

                      {/* Assistant Actions */}
                      {showActions && !isReadonly && (
                        <div className="flex items-center gap-1">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="px-2 h-7 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-all"
                                onClick={handleCopy}
                              >
                                <Copy size={14} />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Copy</TooltipContent>
                          </Tooltip>
                          {onRegenerate && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="px-2 h-7 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-all"
                                  onClick={handleRegenerate}
                                >
                                  <RotateCcw size={14} />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Regenerate</TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                /* Edit Mode for Assistant */
                <div className="flex flex-row gap-2 items-start">
                  <MessageEditor
                    message={message}
                    onSave={handleSaveEdit}
                    onCancel={handleCancelEdit}
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {/* User Messages - Right aligned floating bubbles */}
        {message.role === "user" && (
          <div className="flex justify-end w-full">
            <div className="flex flex-col gap-2 max-w-2xl">
              {/* User Attachments */}
              {message.attachments && message.attachments.length > 0 && (
                <div className="flex flex-row justify-end gap-2">
                  {message.attachments.map((attachment) => (
                    <div
                      key={attachment.id}
                      className="px-3 py-2 bg-muted rounded-lg text-sm"
                    >
                      {attachment.name}
                    </div>
                  ))}
                </div>
              )}

              {/* User Message Bubble */}
              {mode === "view" ? (
                <div className="flex items-start gap-2 justify-end">
                  {/* User Actions - Left of bubble when hovered */}
                  {showActions && !isReadonly && isHovered && (
                    <div className="flex items-center gap-1 mt-1">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="px-2 h-7 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-all"
                            onClick={handleCopy}
                          >
                            <CopyIcon size={14} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Copy</TooltipContent>
                      </Tooltip>
                    </div>
                  )}

                  {/* User Message Content */}
                  <div className="relative">
                    <div
                      data-testid="message-content"
                      className="bg-primary text-primary-foreground px-4 py-3 rounded-2xl max-w-fit"
                    >
                      <div className="whitespace-pre-wrap break-words font-medium">
                        {sanitizeText(message.content)}
                      </div>
                    </div>
                    {/* Timestamp - absolute positioned below message */}
                    {isHovered && (
                      <div className="absolute -bottom-6 right-0 text-xs text-muted-foreground/60">
                        {formatTimestamp(message.timestamp)}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                /* Edit Mode for User */
                <div className="w-full">
                  <MessageEditor
                    message={message}
                    onSave={handleSaveEdit}
                    onCancel={handleCancelEdit}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
};

export const Message = memo(PureMessage, (prevProps, nextProps) => {
  return (
    prevProps.message.id === nextProps.message.id &&
    prevProps.message.content === nextProps.message.content &&
    prevProps.isLoading === nextProps.isLoading &&
    JSON.stringify(prevProps.message.toolCalls) ===
      JSON.stringify(nextProps.message.toolCalls) &&
    JSON.stringify(prevProps.message.toolResults) ===
      JSON.stringify(nextProps.message.toolResults)
  );
});
