import {
  useRef,
  useState,
  useCallback,
  useLayoutEffect,
  type ChangeEvent,
} from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { usePostHog } from "posthog-js/react";
import { cn } from "@/lib/chat-utils";
import { standardEventProps } from "@/lib/PosthogUtils";
import { Button } from "@/components/ui/button";
import { TextareaAutosize } from "@/components/ui/textarea-autosize";
import { PromptsPopover } from "@/components/chat-v2/chat-input/prompts/mcp-prompts-popover";
import {
  ArrowUp,
  Square,
  Paperclip,
  ShieldCheck,
  Plus,
  Settings2,
  Loader2,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { FileAttachmentCard } from "@/components/chat-v2/chat-input/attachments/file-attachment-card";
import {
  type FileAttachment,
  validateFile,
  createFileAttachment,
  revokeFileAttachmentUrls,
  getFileInputAccept,
} from "@/components/chat-v2/chat-input/attachments/file-utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ModelSelector } from "@/components/chat-v2/chat-input/model-selector";
import { ModelDefinition, ServerFormData } from "@/shared/types";
import { AddServerModal } from "@/components/connection/AddServerModal";
import type { ServerWithName } from "@/hooks/use-app-state";
import { SystemPromptSelector } from "@/components/chat-v2/chat-input/system-prompt-selector";
import { useTextareaCaretPosition } from "@/hooks/use-textarea-caret-position";
import {
  Context,
  ContextTrigger,
  ContextContent,
  ContextContentHeader,
  ContextContentBody,
  ContextInputUsage,
  ContextOutputUsage,
  ContextMCPServerUsage,
  ContextSystemPromptUsage,
} from "@/components/chat-v2/chat-input/context";
import {
  type MCPPromptResult,
  isMCPPromptsRequested,
} from "@/components/chat-v2/chat-input/prompts/mcp-prompts-popover";
import { MCPPromptResultCard } from "@/components/chat-v2/chat-input/prompts/mcp-prompt-result-card";
import type { SkillResult } from "@/components/chat-v2/chat-input/skills/skill-types";
import { SkillResultCard } from "@/components/chat-v2/chat-input/skills/skill-result-card";
import {
  useSandboxHostStyle,
  useSandboxHostTheme,
} from "@/contexts/sandbox-host-style-context";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { HostStylePillSelector } from "@/components/shared/HostStylePillSelector";
import type { SandboxHostStyle } from "@/lib/sandbox-host-style";

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (
    event: FormEvent<HTMLFormElement>,
    additionalInput?: string,
  ) => void;
  stop: () => void;
  disabled?: boolean;
  submitDisabled?: boolean;
  isLoading?: boolean;
  placeholder?: string;
  className?: string;
  currentModel: ModelDefinition;
  availableModels: ModelDefinition[];
  onModelChange: (model: ModelDefinition) => void;
  multiModelEnabled?: boolean;
  selectedModels?: ModelDefinition[];
  onSelectedModelsChange?: (models: ModelDefinition[]) => void;
  onMultiModelEnabledChange?: (enabled: boolean) => void;
  enableMultiModel?: boolean;
  systemPrompt: string;
  onSystemPromptChange: (prompt: string) => void;
  temperature: number;
  onTemperatureChange: (temperature: number) => void;
  hasMessages?: boolean;
  onResetChat: () => void;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  selectedServers?: string[];
  mcpToolsTokenCount?: Record<string, number> | null;
  mcpToolsTokenCountLoading?: boolean;
  connectedOrConnectingServerConfigs?: Record<string, { name: string }>;
  systemPromptTokenCount?: number | null;
  systemPromptTokenCountLoading?: boolean;
  mcpPromptResults: MCPPromptResult[];
  onChangeMcpPromptResults: (mcpPromptResults: MCPPromptResult[]) => void;
  skillResults: SkillResult[];
  onChangeSkillResults: (skillResults: SkillResult[]) => void;
  /** File attachments for the message */
  fileAttachments?: FileAttachment[];
  /** Callback when file attachments change */
  onChangeFileAttachments?: (files: FileAttachment[]) => void;
  /** Tool approval toggle */
  requireToolApproval?: boolean;
  onRequireToolApprovalChange?: (enabled: boolean) => void;
  /** Shared chat-only mode */
  minimalMode?: boolean;
  /** Main chat: show the Claude/ChatGPT host-style selector in the "+" menu. */
  showHostStyleSelector?: boolean;
  /** Current host style for the selector UI. */
  hostStyle?: SandboxHostStyle;
  /** Shared host-style setter. */
  onHostStyleChange?: (hostStyle: SandboxHostStyle) => void;
  /** Onboarding: pulse the send button with glow animation */
  pulseSubmit?: boolean;
  /** Move the textarea caret to the end when this trigger changes */
  moveCaretToEndTrigger?: number;
  /** All workspace servers for the "+" dropdown server toggles. */
  allServerConfigs?: Record<string, ServerWithName>;
  /** Toggle a server on/off for the current chat session. */
  onServerToggle?: (serverName: string) => void;
  /** Reconnect a disconnected server. */
  onReconnectServer?: (serverName: string) => Promise<void>;
  /** Add a new server (opens the add-server modal). */
  onAddServer?: (formData: ServerFormData) => void;
  /** Hosted sandbox: optional servers not yet connected (Add server popover). */
  sandboxAttachableServers?: Array<{
    serverId: string;
    serverName: string;
    useOAuth: boolean;
  }>;
  onAttachSandboxServer?: (serverId: string) => void;
}

export function ChatInput({
  value,
  onChange,
  onSubmit,
  stop,
  disabled = false,
  submitDisabled = false,
  isLoading = false,
  placeholder = "Type your message...",
  className,
  currentModel,
  availableModels,
  onModelChange,
  multiModelEnabled = false,
  selectedModels,
  onSelectedModelsChange,
  onMultiModelEnabledChange,
  enableMultiModel = false,
  systemPrompt,
  onSystemPromptChange,
  temperature,
  onTemperatureChange,
  onResetChat,
  hasMessages = false,
  tokenUsage,
  selectedServers,
  mcpToolsTokenCount,
  mcpToolsTokenCountLoading = false,
  connectedOrConnectingServerConfigs,
  systemPromptTokenCount,
  systemPromptTokenCountLoading = false,
  mcpPromptResults,
  onChangeMcpPromptResults,
  skillResults,
  onChangeSkillResults,
  fileAttachments = [],
  onChangeFileAttachments,
  requireToolApproval = false,
  onRequireToolApprovalChange,
  minimalMode = false,
  showHostStyleSelector = false,
  hostStyle,
  onHostStyleChange,
  pulseSubmit = false,
  moveCaretToEndTrigger,
  allServerConfigs,
  onServerToggle,
  onReconnectServer,
  onAddServer,
  sandboxAttachableServers,
  onAttachSandboxServer,
}: ChatInputProps) {
  const sandboxHostStyle = useSandboxHostStyle();
  const sandboxHostTheme = useSandboxHostTheme();
  const globalThemeMode = usePreferencesStore((s) => s.themeMode);
  const resolvedThemeMode = sandboxHostTheme ?? globalThemeMode;
  const isDarkSandboxTheme = resolvedThemeMode === "dark";
  const formRef = useRef<HTMLFormElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [caretIndex, setCaretIndex] = useState(0);
  const [mcpPromptPopoverKeyTrigger, setMcpPromptPopoverKeyTrigger] = useState<
    string | null
  >(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const posthog = usePostHog();
  const [plusPopoverOpen, setPlusPopoverOpen] = useState(false);
  const handlePlusPopoverOpenChange = (nextOpen: boolean) => {
    if (nextOpen && !plusPopoverOpen) {
      posthog.capture(
        "chat_options_plus_clicked",
        standardEventProps("chat_input"),
      );
    }
    setPlusPopoverOpen(nextOpen);
  };
  const [addServerModalOpen, setAddServerModalOpen] = useState(false);
  const [systemPromptOpen, setSystemPromptOpen] = useState(false);
  const selectorHostStyle = hostStyle ?? sandboxHostStyle;
  const hasServerRows = Boolean(
    allServerConfigs &&
    onServerToggle &&
    Object.keys(allServerConfigs).length > 0,
  );
  const hasServerOptions = Boolean(onAddServer || hasServerRows);
  const showHostStyleSelectorControl =
    showHostStyleSelector &&
    Boolean(selectorHostStyle) &&
    Boolean(onHostStyleChange);

  const caret = useTextareaCaretPosition(
    textareaRef,
    containerRef,
    value,
    caretIndex,
  );

  useLayoutEffect(() => {
    if (moveCaretToEndTrigger === undefined) return;

    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.focus();
    const end = textarea.value.length;
    textarea.setSelectionRange(end, end);
    setCaretIndex(end);
  }, [moveCaretToEndTrigger]);

  const onMCPPromptSelected = useCallback(
    (mcpPromptResult: MCPPromptResult) => {
      // Add the prompt result to the mcpPromptResults state
      onChangeMcpPromptResults([...mcpPromptResults, mcpPromptResult]);

      // Remove the "/" that triggered the popover
      const textBeforeCaret = value.slice(0, caretIndex);
      const textAfterCaret = value.slice(caretIndex);
      const cleanedBefore = textBeforeCaret.replace(/\/\s*$/, "");
      const newValue = cleanedBefore + textAfterCaret;
      onChange(newValue);
    },
    [value, caretIndex, onChange, mcpPromptResults, onChangeMcpPromptResults],
  );

  const removeMCPPromptResult = (index: number) => {
    onChangeMcpPromptResults(mcpPromptResults.filter((_, i) => i !== index));
  };

  // File attachment handlers
  const handleFileInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (!files || files.length === 0 || !onChangeFileAttachments) return;

      setFileError(null);
      const newAttachments: FileAttachment[] = [];
      const errors: string[] = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const validation = validateFile(file);

        if (validation.valid) {
          newAttachments.push(createFileAttachment(file));
        } else {
          errors.push(`${file.name}: ${validation.error}`);
        }
      }

      if (newAttachments.length > 0) {
        onChangeFileAttachments([...fileAttachments, ...newAttachments]);
      }

      if (errors.length > 0) {
        setFileError(errors.join("\n"));
        // Clear error after 5 seconds
        setTimeout(() => setFileError(null), 5000);
      }

      // Reset input so the same file can be selected again
      event.target.value = "";
    },
    [fileAttachments, onChangeFileAttachments],
  );

  const removeFileAttachment = useCallback(
    (id: string) => {
      if (!onChangeFileAttachments) return;

      const attachment = fileAttachments.find((a) => a.id === id);
      if (attachment) {
        revokeFileAttachmentUrls([attachment]);
      }

      onChangeFileAttachments(fileAttachments.filter((a) => a.id !== id));
    },
    [fileAttachments, onChangeFileAttachments],
  );

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onSkillSelected = useCallback(
    (skillResult: SkillResult) => {
      // Add the skill result to the skillResults state
      onChangeSkillResults([...skillResults, skillResult]);

      // Remove the "/" that triggered the popover
      const textBeforeCaret = value.slice(0, caretIndex);
      const textAfterCaret = value.slice(caretIndex);
      const cleanedBefore = textBeforeCaret.replace(/\/\s*$/, "");
      const newValue = cleanedBefore + textAfterCaret;
      onChange(newValue);
    },
    [value, caretIndex, onChange, skillResults, onChangeSkillResults],
  );

  const removeSkillResult = (index: number) => {
    onChangeSkillResults(skillResults.filter((_, i) => i !== index));
  };

  // Check if there are any results (prompts, skills, or files) selected
  const hasResults =
    mcpPromptResults.length > 0 ||
    skillResults.length > 0 ||
    fileAttachments.length > 0;
  const effectiveSelectedModels =
    selectedModels && selectedModels.length > 0
      ? selectedModels
      : [currentModel];
  const hideContextPopover = multiModelEnabled;

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const currentCaretIndex = event.currentTarget.selectionStart;
    if (
      isMCPPromptsRequested(value, currentCaretIndex) &&
      ["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)
    ) {
      event.preventDefault();
      setMcpPromptPopoverKeyTrigger(event.key);
      return;
    }

    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      const trimmed = value.trim();
      event.preventDefault();
      if (
        (!trimmed && !hasResults) ||
        disabled ||
        submitDisabled ||
        isLoading
      ) {
        return;
      }
      formRef.current?.requestSubmit();
    }
  };

  const renderResultCards = () => {
    if (!hasResults) return null;
    return (
      <div className="px-4 pt-1 pb-0.5">
        <div className="flex flex-wrap gap-1.5">
          {mcpPromptResults.map((mcpPromptResult, index) => (
            <MCPPromptResultCard
              key={`prompt-${index}`}
              mcpPromptResult={mcpPromptResult}
              onRemove={() => removeMCPPromptResult(index)}
            />
          ))}
          {skillResults.map((skillResult, index) => (
            <SkillResultCard
              key={`skill-${index}`}
              skillResult={skillResult}
              onRemove={() => removeSkillResult(index)}
              onUpdate={(updatedSkill) => {
                const newSkillResults = [...skillResults];
                newSkillResults[index] = updatedSkill;
                onChangeSkillResults(newSkillResults);
              }}
            />
          ))}
        </div>
      </div>
    );
  };

  const renderFileAttachmentCards = () => {
    if (fileAttachments.length === 0) return null;
    return (
      <div className="px-4 pt-1 pb-0.5">
        <div className="flex flex-wrap gap-1.5">
          {fileAttachments.map((attachment) => (
            <FileAttachmentCard
              key={attachment.id}
              attachment={attachment}
              onRemove={() => removeFileAttachment(attachment.id)}
            />
          ))}
        </div>
      </div>
    );
  };

  const composerClasses =
    sandboxHostStyle === "chatgpt"
      ? cn(
          "sandbox-host-composer rounded-[1.75rem]",
          isDarkSandboxTheme
            ? "border border-white/10 bg-[#303030] shadow-[0_1px_2px_rgba(0,0,0,0.28),0_4px_24px_rgba(130,130,130,0.14)]"
            : "border border-neutral-200/90 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04),0_4px_22px_rgba(100,100,100,0.08)]",
        )
      : sandboxHostStyle === "claude"
        ? cn(
            "sandbox-host-composer rounded-[1.35rem]",
            isDarkSandboxTheme
              ? "border-[#4b463d] bg-[#30302E] shadow-[0_1px_2px_rgba(0,0,0,0.28),0_4px_22px_rgba(120,120,120,0.12)]"
              : "border border-[#DFDFDB] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.05),0_4px_20px_rgba(110,110,110,0.08)]",
          )
        : "rounded-3xl border border-border/40 bg-muted/70";
  const activeSubmitButtonClasses =
    sandboxHostStyle === "chatgpt"
      ? isDarkSandboxTheme
        ? "bg-[#f4f4f4] text-[#1f1f1f] hover:bg-[#e8e8e8]"
        : "bg-[#1f1f1f] text-white hover:bg-[#303030]"
      : sandboxHostStyle === "claude"
        ? isDarkSandboxTheme
          ? "bg-[#d07b53] text-[#fff7f0] hover:bg-[#c06f49]"
          : "bg-[#e27d47] text-white hover:bg-[#d16f3d]"
        : "bg-primary text-primary-foreground hover:bg-primary/90";
  const inactiveSubmitButtonClasses =
    sandboxHostStyle === "chatgpt"
      ? isDarkSandboxTheme
        ? "bg-[#3a3a3a] text-[#8a8a8a] cursor-not-allowed"
        : "bg-[#e7e7e7] text-[#9b9b9b] cursor-not-allowed"
      : sandboxHostStyle === "claude"
        ? isDarkSandboxTheme
          ? "bg-[#45413b] text-[#8d857a] cursor-not-allowed"
          : "bg-[#ebe5dc] text-[#b6ada0] cursor-not-allowed"
        : "bg-muted text-muted-foreground cursor-not-allowed";

  return (
    <>
      <form
        ref={formRef}
        className={cn("w-full", className)}
        onSubmit={onSubmit}
      >
        <div
          ref={containerRef}
          className={cn(
            "relative flex w-full flex-col px-2 pt-2 pb-2",
            composerClasses,
          )}
        >
          <PromptsPopover
            anchor={caret}
            selectedServers={selectedServers}
            onPromptSelected={onMCPPromptSelected}
            onSkillSelected={onSkillSelected}
            actionTrigger={mcpPromptPopoverKeyTrigger}
            setActionTrigger={setMcpPromptPopoverKeyTrigger}
            value={value}
            caretIndex={caretIndex}
            minimalMode={minimalMode}
          />

          {minimalMode &&
          sandboxAttachableServers &&
          sandboxAttachableServers.length > 0 &&
          onAttachSandboxServer ? (
            <div className="flex flex-wrap items-center gap-2 px-4 pb-1 pt-0.5">
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1 rounded-full border-dashed px-3 text-xs"
                    disabled={disabled}
                    aria-label="Add optional server"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add server
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-72 p-1" align="start">
                  <p className="px-2 py-1.5 text-xs text-muted-foreground">
                    Connect an optional server. You may be asked to authorize.
                  </p>
                  <div className="max-h-48 overflow-y-auto">
                    {sandboxAttachableServers.map((s) => (
                      <button
                        key={s.serverId}
                        type="button"
                        className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm hover:bg-muted/80"
                        onClick={() => onAttachSandboxServer(s.serverId)}
                      >
                        <span className="truncate font-medium">
                          {s.serverName}
                        </span>
                        {s.useOAuth ? (
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            OAuth
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          ) : null}

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={getFileInputAccept()}
            onChange={handleFileInputChange}
            className="hidden"
            aria-hidden="true"
          />

          {/* File Attachment Cards */}
          {renderFileAttachmentCards()}

          {/* MCP Prompts and Skills Cards */}
          {renderResultCards()}

          {/* File validation error */}
          {fileError && (
            <div className="px-4 py-1">
              <p className="text-xs text-destructive whitespace-pre-line">
                {fileError}
              </p>
            </div>
          )}

          <TextareaAutosize
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              setCaretIndex(e.target.selectionStart);
            }}
            onKeyDown={handleKeyDown}
            onKeyUp={(e) => setCaretIndex(e.currentTarget.selectionStart)}
            placeholder={placeholder}
            disabled={disabled}
            readOnly={disabled}
            minRows={2}
            className={cn(
              "max-h-32 min-h-[64px] w-full resize-none border-none bg-transparent dark:bg-transparent px-4",
              "pt-2 pb-3 text-base text-foreground placeholder:text-muted-foreground/70",
              "outline-none focus-visible:outline-none focus-visible:ring-0 shadow-none focus-visible:shadow-none",
              disabled ? "cursor-not-allowed text-muted-foreground" : "",
            )}
            autoFocus={!disabled}
          />

          <div className="@container/toolbar flex items-center justify-between gap-2 px-2 min-w-0">
            <div className="flex items-center gap-1 min-w-0 flex-shrink overflow-hidden">
              {!minimalMode && (
                <Popover
                  open={plusPopoverOpen}
                  onOpenChange={handlePlusPopoverOpenChange}
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <PopoverTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 rounded-full"
                          disabled={disabled}
                          aria-label="Options"
                        >
                          <Plus className="h-4 w-4" />
                        </Button>
                      </PopoverTrigger>
                    </TooltipTrigger>
                    <TooltipContent>Options</TooltipContent>
                  </Tooltip>
                  <PopoverContent
                    className="w-72 p-0"
                    align="start"
                    side="top"
                    sideOffset={8}
                  >
                    {hasServerOptions && (
                      <div className="px-1 pt-1 pb-0">
                        <p className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                          Servers
                        </p>
                        {allServerConfigs &&
                          onServerToggle &&
                          Object.keys(allServerConfigs).length > 0 && (
                            <div className="max-h-48 overflow-y-auto">
                              {Object.entries(allServerConfigs)
                                .sort(([aName, a], [bName, b]) => {
                                  const statusOrder: Record<string, number> = {
                                    connected: 0,
                                    connecting: 1,
                                    failed: 2,
                                  };
                                  const aOrder =
                                    statusOrder[a.connectionStatus] ?? 3;
                                  const bOrder =
                                    statusOrder[b.connectionStatus] ?? 3;
                                  if (aOrder !== bOrder) return aOrder - bOrder;
                                  return aName.localeCompare(bName);
                                })
                                .map(([name, server]) => {
                                  const isSelected =
                                    selectedServers?.includes(name) ?? false;
                                  const isConnected =
                                    server.connectionStatus === "connected";
                                  const isConnecting =
                                    server.connectionStatus === "connecting";
                                  const isFailed =
                                    server.connectionStatus === "failed";
                                  const statusColor = isConnected
                                    ? "bg-green-500 dark:bg-green-400"
                                    : isConnecting
                                      ? "bg-yellow-500 dark:bg-yellow-400 animate-pulse"
                                      : isFailed
                                        ? "bg-red-500 dark:bg-red-400"
                                        : "bg-muted-foreground";

                                  return (
                                    <div
                                      key={name}
                                      className="flex items-center justify-between gap-2 rounded-md px-2 py-2 hover:bg-muted/60"
                                    >
                                      <div className="flex items-center gap-2 min-w-0">
                                        <div
                                          className={cn(
                                            "w-2 h-2 rounded-full shrink-0",
                                            statusColor,
                                          )}
                                        />
                                        <span
                                          className={cn(
                                            "text-sm font-medium truncate",
                                            !isConnected &&
                                              !isConnecting &&
                                              "text-muted-foreground",
                                          )}
                                        >
                                          {name}
                                        </span>
                                        <span className="text-[10px] text-muted-foreground shrink-0">
                                          {server.config.command
                                            ? "STDIO"
                                            : "HTTP"}
                                        </span>
                                      </div>
                                      <div className="flex items-center shrink-0">
                                        {isConnecting ? (
                                          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                                        ) : isConnected ? (
                                          <Switch
                                            checked={isSelected}
                                            onCheckedChange={() =>
                                              onServerToggle(name)
                                            }
                                          />
                                        ) : (
                                          <button
                                            type="button"
                                            className="text-xs font-medium text-primary hover:text-primary/80 transition-colors cursor-pointer px-1.5 py-0.5 rounded hover:bg-primary/5"
                                            onClick={() => {
                                              if (!isSelected) {
                                                onServerToggle(name);
                                              }
                                              onReconnectServer?.(name).catch(
                                                () => {},
                                              );
                                            }}
                                          >
                                            {isFailed ? "Retry" : "Connect"}
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                            </div>
                          )}
                        {onAddServer && (
                          <button
                            type="button"
                            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/60 cursor-pointer"
                            onClick={() => {
                              setPlusPopoverOpen(false);
                              setAddServerModalOpen(true);
                            }}
                          >
                            <Plus className="h-3.5 w-3.5" />
                            Add server
                          </button>
                        )}
                      </div>
                    )}

                    <div
                      className={cn(
                        "px-1 pb-1",
                        allServerConfigs &&
                          Object.keys(allServerConfigs).length > 0 &&
                          "border-t border-border mt-1 pt-1",
                      )}
                    >
                      {onChangeFileAttachments && (
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted/60 cursor-pointer"
                          onClick={() => {
                            posthog.capture(
                              "chat_attachment_button_clicked",
                              standardEventProps("chat_input"),
                            );
                            setPlusPopoverOpen(false);
                            openFilePicker();
                          }}
                        >
                          <Paperclip className="h-4 w-4 text-muted-foreground" />
                          Attach files
                        </button>
                      )}

                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted/60 cursor-pointer"
                        onClick={() => {
                          setPlusPopoverOpen(false);
                          setSystemPromptOpen(true);
                        }}
                      >
                        <Settings2 className="h-4 w-4 text-muted-foreground" />
                        System Prompt & Temperature
                      </button>

                      {onRequireToolApprovalChange && (
                        <div className="flex items-center justify-between gap-2 rounded-md px-2 py-2 hover:bg-muted/60">
                          <div className="flex items-center gap-2 text-sm">
                            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                            Tool Approval
                          </div>
                          <Switch
                            checked={requireToolApproval}
                            onCheckedChange={(checked) =>
                              onRequireToolApprovalChange(checked)
                            }
                          />
                        </div>
                      )}

                      {showHostStyleSelectorControl && selectorHostStyle && (
                        <div className="mt-1 border-t border-border/70 px-2 py-[5px]">
                          <div className="flex items-center justify-between gap-2">
                            <p className="shrink-0 text-[9px] font-medium text-muted-foreground uppercase tracking-[0.18em]">
                              Host Style
                            </p>
                            <HostStylePillSelector
                              className="w-[164px] shrink-0"
                              value={selectorHostStyle}
                              onValueChange={(nextStyle) =>
                                onHostStyleChange?.(nextStyle)
                              }
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </PopoverContent>
                </Popover>
              )}
              {!minimalMode && (
                <ModelSelector
                  currentModel={currentModel}
                  availableModels={availableModels}
                  onModelChange={onModelChange}
                  isLoading={isLoading}
                  hasMessages={hasMessages}
                  enableMultiModel={enableMultiModel}
                  multiModelEnabled={multiModelEnabled}
                  selectedModels={effectiveSelectedModels}
                  onSelectedModelsChange={onSelectedModelsChange}
                  onMultiModelEnabledChange={onMultiModelEnabledChange}
                />
              )}
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              {!minimalMode && !hideContextPopover && (
                <Context
                  usedTokens={tokenUsage?.totalTokens ?? 0}
                  usage={
                    tokenUsage && tokenUsage.totalTokens > 0
                      ? {
                          inputTokens: tokenUsage.inputTokens,
                          outputTokens: tokenUsage.outputTokens,
                          totalTokens: tokenUsage.totalTokens,
                          inputTokenDetails: {
                            noCacheTokens: undefined,
                            cacheReadTokens: undefined,
                            cacheWriteTokens: undefined,
                          },
                          outputTokenDetails: {
                            textTokens: undefined,
                            reasoningTokens: undefined,
                          },
                        }
                      : undefined
                  }
                  modelId={`${currentModel.id}`}
                  selectedServers={selectedServers}
                  mcpToolsTokenCount={mcpToolsTokenCount}
                  mcpToolsTokenCountLoading={mcpToolsTokenCountLoading}
                  connectedOrConnectingServerConfigs={
                    connectedOrConnectingServerConfigs
                  }
                  systemPromptTokenCount={systemPromptTokenCount}
                  systemPromptTokenCountLoading={systemPromptTokenCountLoading}
                  hasMessages={hasMessages}
                >
                  <ContextTrigger />
                  {/* Only render popover content when there's something to show */}
                  {(hasMessages && tokenUsage && tokenUsage.totalTokens > 0) ||
                  (systemPromptTokenCount && systemPromptTokenCount > 0) ||
                  systemPromptTokenCountLoading ||
                  (mcpToolsTokenCount &&
                    Object.keys(mcpToolsTokenCount).length > 0) ||
                  mcpToolsTokenCountLoading ? (
                    <ContextContent>
                      {hasMessages &&
                        tokenUsage &&
                        tokenUsage.totalTokens > 0 && <ContextContentHeader />}
                      <ContextContentBody>
                        {hasMessages &&
                          tokenUsage &&
                          tokenUsage.totalTokens > 0 && (
                            <>
                              <ContextInputUsage />
                              <ContextOutputUsage />
                            </>
                          )}
                        <ContextSystemPromptUsage />
                        <ContextMCPServerUsage />
                      </ContextContentBody>
                    </ContextContent>
                  ) : null}
                </Context>
              )}
              {isLoading ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon"
                      variant="secondary"
                      className="size-[34px] rounded-full transition-colors"
                      aria-label="Stop generating"
                      onClick={() => stop()}
                    >
                      <Square size={16} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Stop generating</TooltipContent>
                </Tooltip>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="submit"
                      size="icon"
                      aria-label="Send message"
                      className={cn(
                        "size-[34px] rounded-full transition-colors shadow-none",
                        (value.trim() || hasResults) &&
                          !disabled &&
                          !submitDisabled
                          ? activeSubmitButtonClasses
                          : inactiveSubmitButtonClasses,
                        pulseSubmit && "animate-onboarding-pulse",
                      )}
                      disabled={
                        (!value.trim() && !hasResults) ||
                        disabled ||
                        submitDisabled
                      }
                    >
                      <ArrowUp size={16} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Send message</TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>
        </div>
      </form>

      {onAddServer && (
        <AddServerModal
          isOpen={addServerModalOpen}
          onClose={() => setAddServerModalOpen(false)}
          onSubmit={(formData) => {
            onAddServer(formData);
            setAddServerModalOpen(false);
          }}
        />
      )}

      {!minimalMode && (
        <SystemPromptSelector
          systemPrompt={
            systemPrompt ||
            "You are a helpful assistant with access to MCP tools."
          }
          onSystemPromptChange={onSystemPromptChange}
          temperature={temperature}
          onTemperatureChange={onTemperatureChange}
          isLoading={isLoading}
          hasMessages={hasMessages}
          onResetChat={onResetChat}
          currentModel={currentModel}
          multiModelEnabled={multiModelEnabled}
          selectedModels={effectiveSelectedModels}
          open={systemPromptOpen}
          onOpenChange={setSystemPromptOpen}
        />
      )}
    </>
  );
}
