"use client";

import { memo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn, formatTimestamp, sanitizeText } from "@/lib/chat-utils";
import { ChatMessage } from "@/lib/chat-types";
import {
  BotIcon,
  UserIcon,
  PencilEditIcon,
  MoreIcon,
  CopyIcon,
  RefreshIcon,
} from "./icons";
import { Markdown } from "./markdown";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { MessageEditor } from "./message-editor";
import { ToolCallDisplay } from "./tool-call-display";

interface MessageProps {
  message: ChatMessage;
  isLoading?: boolean;
  onEdit?: (messageId: string, newContent: string) => void;
  onRegenerate?: (messageId: string) => void;
  onCopy?: (content: string) => void;
  isReadonly?: boolean;
  showActions?: boolean;
}

const PureMessage = ({
  message,
  onEdit,
  onRegenerate,
  onCopy,
  isReadonly = false,
  showActions = true,
}: MessageProps) => {
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [isHovered, setIsHovered] = useState(false);

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
        <div
          className={cn("flex gap-4 w-full", {
            "group-data-[role=user]/message:ml-auto group-data-[role=user]/message:max-w-2xl":
              message.role === "user" && mode !== "edit",
            "w-full": mode === "edit",
          })}
        >
          {/* Avatar */}
          {message.role === "assistant" && (
            <div className="size-8 flex items-center rounded-full justify-center ring-1 shrink-0 ring-border bg-background">
              <BotIcon />
            </div>
          )}

          {message.role === "user" && mode === "view" && (
            <div className="size-8 flex items-center rounded-full justify-center ring-1 shrink-0 ring-border bg-primary text-primary-foreground">
              <UserIcon />
            </div>
          )}

          {/* Message Content */}
          <div className="flex flex-col gap-4 w-full min-w-0">
            {/* Attachments */}
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

            {/* Tool Calls */}
            {message.toolCalls && message.toolCalls.length > 0 && (
              <div className="space-y-2">
                {message.toolCalls.map((toolCall) => (
                  <ToolCallDisplay key={toolCall.id} toolCall={toolCall} />
                ))}
              </div>
            )}

            {/* Main Content */}
            {mode === "view" ? (
              <div className="flex flex-row gap-2 items-start">
                {/* Edit Button for User Messages */}
                {message.role === "user" && !isReadonly && showActions && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        data-testid="message-edit-button"
                        variant="ghost"
                        size="sm"
                        className={cn(
                          "px-2 h-fit rounded-full text-muted-foreground transition-opacity",
                          isHovered ? "opacity-100" : "opacity-0",
                        )}
                        onClick={handleEdit}
                      >
                        <PencilEditIcon size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Edit message</TooltipContent>
                  </Tooltip>
                )}

                {/* Message Text */}
                <div
                  data-testid="message-content"
                  className={cn("flex flex-col gap-4 flex-1 min-w-0", {
                    "bg-primary text-primary-foreground px-3 py-2 rounded-xl":
                      message.role === "user",
                    "prose prose-sm max-w-none dark:prose-invert":
                      message.role === "assistant",
                  })}
                >
                  {message.role === "assistant" ? (
                    <Markdown>{sanitizeText(message.content)}</Markdown>
                  ) : (
                    <div className="whitespace-pre-wrap break-words">
                      {sanitizeText(message.content)}
                    </div>
                  )}

                  {/* Timestamp */}
                  <div
                    className={cn(
                      "text-xs mt-1",
                      message.role === "user"
                        ? "text-primary-foreground/70"
                        : "text-muted-foreground",
                    )}
                  >
                    {formatTimestamp(message.timestamp)}
                  </div>
                </div>

                {/* Message Actions */}
                {showActions && !isReadonly && (
                  <div
                    className={cn(
                      "transition-opacity",
                      isHovered ? "opacity-100" : "opacity-0",
                    )}
                  >
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="px-2 h-fit rounded-full text-muted-foreground"
                        >
                          <MoreIcon size={14} />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={handleCopy}>
                          <CopyIcon size={14} />
                          Copy
                        </DropdownMenuItem>
                        {message.role === "assistant" && onRegenerate && (
                          <DropdownMenuItem onClick={handleRegenerate}>
                            <RefreshIcon size={14} />
                            Regenerate
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                )}
              </div>
            ) : (
              /* Edit Mode */
              <div className="flex flex-row gap-2 items-start">
                <div className="size-8" />
                <MessageEditor
                  message={message}
                  onSave={handleSaveEdit}
                  onCancel={handleCancelEdit}
                />
              </div>
            )}
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
};

export const Message = memo(PureMessage, (prevProps, nextProps) => {
  return (
    prevProps.message.id === nextProps.message.id &&
    prevProps.message.content === nextProps.message.content &&
    prevProps.isLoading === nextProps.isLoading
  );
});
