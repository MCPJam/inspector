import { memo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { formatTimestamp, sanitizeText, isImageFile } from "@/lib/chat-utils";
import { ChatMessage } from "@/lib/chat-types";
import { Check, Copy, CopyIcon, RotateCcw } from "lucide-react";
import { Markdown } from "./markdown";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { MessageEditor } from "./message-editor";
import { ToolCallDisplay } from "./tool-call";
import { getProviderLogoFromModel } from "./chat-helpers";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { ModelDefinition } from "@/shared/types.js";
import { MCPServerConfig } from "@/sdk";
import { Alert, AlertDescription } from "../ui/alert";

// Reusable Image Attachment Component
const ImageAttachment = ({
  attachment,
  align = "left",
}: {
  attachment: any;
  align?: "left" | "right";
}) => {
  const [imageError, setImageError] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  if (imageError) {
    return (
      <div
        className={`px-3 py-2 bg-muted rounded-lg text-sm text-muted-foreground ${
          align === "right" ? "text-right" : ""
        }`}
      >
        Failed to load image: {attachment.name}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        className={`text-xs text-muted-foreground font-medium ${
          align === "right" ? "text-right" : ""
        }`}
      >
        {attachment.name}
      </div>
      <div className="flex justify-center">
        <img
          src={attachment.url}
          alt={attachment.name}
          className={`max-w-full h-auto rounded-lg border border-border/30 shadow-sm cursor-pointer transition-all hover:shadow-md ${
            isExpanded ? "max-h-none" : "max-h-96"
          }`}
          loading="lazy"
          onClick={() => setIsExpanded(!isExpanded)}
          onError={() => setImageError(true)}
          title={isExpanded ? "Click to collapse" : "Click to expand"}
        />
      </div>
    </div>
  );
};

interface MessageProps {
  message: ChatMessage;
  isLoading?: boolean;
  onEdit?: (messageId: string, newContent: string) => void;
  onRegenerate?: (messageId: string) => void;
  onCopy?: (content: string) => void;
  isReadonly?: boolean;
  showActions?: boolean;
  model: ModelDefinition | null;
  serverConfigs?: Record<string, MCPServerConfig>;
  onCallTool?: (toolName: string, params: Record<string, any>) => Promise<any>;
  onSendFollowup?: (message: string) => void;
  toolsMetadata?: Record<string, Record<string, any>>; // Map of tool name -> tool._meta
  serverId?: string; // Server ID for widget rendering
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
  serverConfigs,
  onCallTool,
  onSendFollowup,
  toolsMetadata,
  serverId,
}: MessageProps) => {
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [isHovered, setIsHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const themeMode = usePreferencesStore((s) => s.themeMode);

  const handleCopy = () => {
    if (onCopy) {
      onCopy(message.content);
    } else {
      navigator.clipboard.writeText(message.content);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000); // Reset after 2 seconds
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
                <div className="flex flex-col gap-3">
                  {message.attachments.map((attachment) => {
                    const isImage = isImageFile({
                      type: attachment.contentType,
                    } as File);

                    if (isImage) {
                      return (
                        <ImageAttachment
                          key={attachment.id}
                          attachment={attachment}
                        />
                      );
                    }

                    // Non-image attachments
                    return (
                      <div
                        key={attachment.id}
                        className="px-3 py-2 bg-muted rounded-lg text-sm flex items-center gap-2"
                      >
                        <span>📎</span>
                        <span>{attachment.name}</span>
                        {attachment.size && (
                          <span className="text-xs text-muted-foreground">
                            ({(attachment.size / 1024).toFixed(1)} KB)
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Interleaved Content Blocks or Fallback */}
              {message.contentBlocks && message.contentBlocks.length > 0 ? (
                <div className="space-y-4">
                  {message.contentBlocks.map((block, index) => {
                    if (block.type === "text" && block.content) {
                      return (
                        <motion.div
                          key={block.id}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.3, delay: index * 0.05 }}
                          className="prose prose-sm max-w-none dark:prose-invert prose-p:leading-relaxed prose-pre:bg-muted/50 prose-pre:border prose-pre:border-border/30 flex-1 min-w-0"
                        >
                          <Markdown>{sanitizeText(block.content)}</Markdown>
                        </motion.div>
                      );
                    } else if (block.type === "tool_call" && block.toolCall) {
                      return (
                        <motion.div
                          key={block.id}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.3, delay: index * 0.05 }}
                        >
                          <ToolCallDisplay
                            toolCall={block.toolCall}
                            toolResult={block.toolResult}
                            serverConfigs={serverConfigs}
                            onCallTool={onCallTool}
                            onSendFollowup={onSendFollowup}
                            toolMeta={toolsMetadata?.[block.toolCall.name]}
                            serverId={serverId}
                          />
                        </motion.div>
                      );
                    } else if (block.type === "error" && block.content) {
                      return (
                        <motion.div
                          key={block.id}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.3, delay: index * 0.05 }}
                        >
                          <Alert variant="destructive">
                            <AlertDescription className="whitespace-pre-wrap break-words">
                              <strong>Error:</strong> {block.content}
                            </AlertDescription>
                          </Alert>
                        </motion.div>
                      );
                    }
                    return null;
                  })}
                </div>
              ) : (
                <>
                  {/* Fallback to old structure for backwards compatibility */}
                  {/* Tool Calls */}
                  {message.toolCalls && message.toolCalls.length > 0 && (
                    <div className="space-y-2">
                      {message.toolCalls.map((toolCall, index) => {
                        const toolResult = message.toolResults?.find(
                          (tr) => tr.toolCallId === toolCall.id,
                        );
                        return (
                          <motion.div
                            key={toolCall.id}
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.3, delay: index * 0.1 }}
                          >
                            <ToolCallDisplay
                              toolCall={toolCall}
                              toolResult={toolResult}
                              serverConfigs={serverConfigs}
                              onCallTool={onCallTool}
                              onSendFollowup={onSendFollowup}
                              toolMeta={toolsMetadata?.[toolCall.name]}
                              serverId={serverId}
                            />
                          </motion.div>
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
                  ) : mode === "view" && message.content ? (
                    <div className="prose prose-sm max-w-none dark:prose-invert prose-p:leading-relaxed prose-pre:bg-muted/50 prose-pre:border prose-pre:border-border/30 flex-1 min-w-0">
                      <Markdown>{sanitizeText(message.content)}</Markdown>
                    </div>
                  ) : null}
                </>
              )}

              {/* Thinking Indicator for interleaved content */}
              {shouldShowThinking && message.contentBlocks && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.3 }}
                >
                  <ThinkingIndicator />
                </motion.div>
              )}

              {/* Timestamp and Actions - Positioned below content */}
              {mode === "view" && (
                <div
                  className={`flex items-center justify-between mt-4 transition-opacity duration-200 ${isHovered ? "opacity-100" : "opacity-0"}`}
                >
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
                            {copied ? <Check size={14} /> : <Copy size={14} />}
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

              {mode === "edit" && (
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
                <div className="flex flex-col gap-3">
                  {message.attachments.map((attachment) => {
                    const isImage = isImageFile({
                      type: attachment.contentType,
                    } as File);

                    if (isImage) {
                      return (
                        <ImageAttachment
                          key={attachment.id}
                          attachment={attachment}
                          align="right"
                        />
                      );
                    }

                    // Non-image attachments
                    return (
                      <div
                        key={attachment.id}
                        className="px-3 py-2 bg-muted rounded-lg text-sm flex items-center gap-2 justify-end"
                      >
                        <span>{attachment.name}</span>
                        <span>📎</span>
                        {attachment.size && (
                          <span className="text-xs text-muted-foreground">
                            ({(attachment.size / 1024).toFixed(1)} KB)
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* User Message Bubble */}
              {mode === "view" ? (
                <div className="flex items-start gap-2 justify-end">
                  {/* User Actions - Left of bubble when hovered */}
                  {showActions && !isReadonly && (
                    <div
                      className={`flex items-center gap-1 mt-1 transition-opacity duration-200 ${isHovered ? "opacity-100" : "opacity-0"}`}
                    >
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
                    <div
                      className={`absolute -bottom-6 right-0 text-xs text-muted-foreground/60 transition-opacity duration-200 ${isHovered ? "opacity-100" : "opacity-0"}`}
                    >
                      {formatTimestamp(message.timestamp)}
                    </div>
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
      JSON.stringify(nextProps.message.toolResults) &&
    JSON.stringify(prevProps.message.contentBlocks) ===
      JSON.stringify(nextProps.message.contentBlocks)
  );
});
