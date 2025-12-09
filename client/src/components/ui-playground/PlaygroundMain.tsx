/**
 * PlaygroundMain
 *
 * Main center panel for the UI Playground that combines:
 * - Deterministic tool execution (injected as messages)
 * - LLM-driven chat continuation
 * - Widget rendering via Thread component
 *
 * Uses the shared useChatSession hook for chat infrastructure.
 * Device/display mode handling is delegated to the Thread component
 * which manages PiP/fullscreen at the widget level.
 */

import { FormEvent, useState, useEffect, useCallback, useMemo } from "react";
import {
  ArrowDown,
  Braces,
  Loader2,
  Smartphone,
  Tablet,
  Monitor,
  Trash2,
  Sun,
  Moon,
  Globe,
  Shield,
  MousePointer2,
  Hand,
} from "lucide-react";
import { ModelDefinition } from "@/shared/types";
import { Thread } from "@/components/chat-v2/thread";
import { ChatInput } from "@/components/chat-v2/chat-input";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { formatErrorMessage } from "@/components/chat-v2/chat-helpers";
import { ErrorBox } from "@/components/chat-v2/error";
import { ConfirmChatResetDialog } from "@/components/chat-v2/confirm-chat-reset-dialog";
import { useChatSession } from "@/hooks/use-chat-session";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { updateThemeMode } from "@/lib/theme-utils";
import { createDeterministicToolMessages } from "./playground-helpers";
import type { MCPPromptResult } from "@/components/chat-v2/mcp-prompts-popover";
import {
  useUIPlaygroundStore,
  type DeviceType,
  type DisplayMode,
  type CspMode,
} from "@/stores/ui-playground-store";
import { SafeAreaEditor } from "./SafeAreaEditor";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";

/** Device frame configurations */
const DEVICE_CONFIGS: Record<
  DeviceType,
  { width: number; height: number; label: string; icon: typeof Smartphone }
> = {
  mobile: { width: 430, height: 932, label: "Phone", icon: Smartphone },
  tablet: { width: 820, height: 1180, label: "Tablet", icon: Tablet },
  desktop: { width: 1280, height: 800, label: "Desktop", icon: Monitor },
};

/** Common BCP 47 locales for testing (per OpenAI Apps SDK spec) */
const LOCALE_OPTIONS = [
  { code: "en-US", label: "English (US)" },
  { code: "en-GB", label: "English (UK)" },
  { code: "es-ES", label: "Español" },
  { code: "es-MX", label: "Español (MX)" },
  { code: "fr-FR", label: "Français" },
  { code: "de-DE", label: "Deutsch" },
  { code: "it-IT", label: "Italiano" },
  { code: "pt-BR", label: "Português (BR)" },
  { code: "ja-JP", label: "日本語" },
  { code: "zh-CN", label: "简体中文" },
  { code: "zh-TW", label: "繁體中文" },
  { code: "ko-KR", label: "한국어" },
  { code: "ar-SA", label: "العربية" },
  { code: "hi-IN", label: "हिन्दी" },
  { code: "ru-RU", label: "Русский" },
  { code: "nl-NL", label: "Nederlands" },
];

/** CSP mode options for widget sandbox */
const CSP_MODE_OPTIONS: {
  mode: CspMode;
  label: string;
  description: string;
}[] = [
  {
    mode: "permissive",
    label: "Permissive",
    description: "Allows all HTTPS resources",
  },
  {
    mode: "widget-declared",
    label: "Strict",
    description: "Only widget-declared domains",
  },
];

interface PlaygroundMainProps {
  serverName: string;
  onWidgetStateChange?: (toolCallId: string, state: unknown) => void;
  // Execution state for "Invoking" indicator
  isExecuting?: boolean;
  executingToolName?: string | null;
  invokingMessage?: string | null;
  // Deterministic execution
  pendingExecution: {
    toolName: string;
    params: Record<string, unknown>;
    result: unknown;
    toolMeta: Record<string, unknown> | undefined;
  } | null;
  onExecutionInjected: () => void;
  // Device emulation
  deviceType?: DeviceType;
  onDeviceTypeChange?: (type: DeviceType) => void;
  displayMode?: DisplayMode;
  onDisplayModeChange?: (mode: DisplayMode) => void;
  // Locale (BCP 47)
  locale?: string;
  onLocaleChange?: (locale: string) => void;
}

function ScrollToBottomButton() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  if (isAtBottom) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 flex bottom-12 justify-center animate-in slide-in-from-bottom fade-in duration-200">
      <button
        type="button"
        className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-border bg-background/90 px-2 py-2 text-xs font-medium shadow-sm transition hover:bg-accent"
        onClick={() => scrollToBottom({ animation: "smooth" })}
      >
        <ArrowDown className="h-4 w-4" />
      </button>
    </div>
  );
}

// Invoking indicator component (ChatGPT-style "Invoking [toolName]")
function InvokingIndicator({
  toolName,
  customMessage,
}: {
  toolName: string;
  customMessage?: string | null;
}) {
  return (
    <div className="max-w-4xl mx-auto px-4 py-3">
      <div className="flex items-center gap-2 text-sm text-foreground">
        <Braces className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        {customMessage ? (
          <span>{customMessage}</span>
        ) : (
          <>
            <span>Invoking</span>
            <code className="text-primary font-mono">{toolName}</code>
          </>
        )}
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground ml-auto" />
      </div>
    </div>
  );
}

export function PlaygroundMain({
  serverName,
  onWidgetStateChange,
  isExecuting,
  executingToolName,
  invokingMessage,
  pendingExecution,
  onExecutionInjected,
  deviceType = "mobile",
  onDeviceTypeChange,
  displayMode = "inline",
  onDisplayModeChange,
  locale = "en-US",
  onLocaleChange,
}: PlaygroundMainProps) {
  const posthog = usePostHog();
  const [input, setInput] = useState("");
  const [mcpPromptResults, setMcpPromptResults] = useState<MCPPromptResult[]>(
    [],
  );
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [isWidgetFullscreen, setIsWidgetFullscreen] = useState(false);

  // Device config
  const deviceConfig = DEVICE_CONFIGS[deviceType];
  const DeviceIcon = deviceConfig.icon;

  // Theme handling
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const setThemeMode = usePreferencesStore((s) => s.setThemeMode);

  const handleThemeChange = useCallback(() => {
    const newTheme = themeMode === "dark" ? "light" : "dark";
    updateThemeMode(newTheme);
    setThemeMode(newTheme);
  }, [themeMode, setThemeMode]);

  // Single server for playground
  const selectedServers = useMemo(
    () => (serverName ? [serverName] : []),
    [serverName],
  );

  // Use shared chat session hook
  const {
    messages,
    setMessages,
    sendMessage,
    stop,
    status,
    error,
    selectedModel,
    setSelectedModel,
    availableModels,
    isAuthLoading,
    systemPrompt,
    setSystemPrompt,
    temperature,
    setTemperature,
    toolsMetadata,
    toolServerMap,
    tokenUsage,
    resetChat,
    isStreaming,
    disableForAuthentication,
    submitBlocked,
  } = useChatSession({
    selectedServers,
    onReset: () => {
      setInput("");
    },
  });

  // Set playground active flag for widget renderers to read
  const setPlaygroundActive = useUIPlaygroundStore(
    (s) => s.setPlaygroundActive,
  );
  useEffect(() => {
    setPlaygroundActive(true);
    return () => setPlaygroundActive(false);
  }, [setPlaygroundActive]);

  // CSP mode from store
  const cspMode = useUIPlaygroundStore((s) => s.cspMode);
  const setCspMode = useUIPlaygroundStore((s) => s.setCspMode);

  // Device capabilities from store
  const capabilities = useUIPlaygroundStore((s) => s.capabilities);
  const setCapabilities = useUIPlaygroundStore((s) => s.setCapabilities);

  // Check if thread is empty
  const isThreadEmpty = !messages.some(
    (msg) => msg.role === "user" || msg.role === "assistant",
  );

  // Handle deterministic execution injection
  useEffect(() => {
    if (!pendingExecution) return;

    const { toolName, params, result, toolMeta } = pendingExecution;
    const { messages: newMessages } = createDeterministicToolMessages(
      toolName,
      params,
      result,
      toolMeta,
    );

    setMessages((prev) => [...prev, ...newMessages]);
    onExecutionInjected();
  }, [pendingExecution, setMessages, onExecutionInjected]);

  // Handle widget state changes
  const handleWidgetStateChange = useCallback(
    (toolCallId: string, state: unknown) => {
      onWidgetStateChange?.(toolCallId, state);
    },
    [onWidgetStateChange],
  );

  // Handle follow-up messages from widgets
  const handleSendFollowUp = useCallback(
    (text: string) => {
      sendMessage({ text });
    },
    [sendMessage],
  );

  // Handle clear chat
  const handleClearChat = useCallback(() => {
    resetChat();
    setShowClearConfirm(false);
  }, [resetChat]);

  // Placeholder text
  let placeholder = "Ask something to render UI...";
  if (isAuthLoading) {
    placeholder = "Loading...";
  } else if (disableForAuthentication) {
    placeholder = "Sign in to use chat";
  }

  // Submit handler
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      (input.trim() || mcpPromptResults.length > 0) &&
      status === "ready" &&
      !submitBlocked
    ) {
      posthog.capture("app_builder_send_message", {
        location: "app_builder_tab",
        platform: detectPlatform(),
        environment: detectEnvironment(),
        model_id: selectedModel?.id ?? null,
        model_name: selectedModel?.name ?? null,
        model_provider: selectedModel?.provider ?? null,
      });
      sendMessage({ text: input });
      setInput("");
      setMcpPromptResults([]);
    }
  };

  const errorMessage = formatErrorMessage(error);
  const inputDisabled = status !== "ready" || submitBlocked;

  // Compact mode for smaller devices
  const isCompact = deviceType === "mobile" || deviceType === "tablet";

  // Shared chat input props
  const sharedChatInputProps = {
    value: input,
    onChange: setInput,
    onSubmit,
    stop,
    disabled: inputDisabled,
    isLoading: isStreaming,
    placeholder,
    currentModel: selectedModel,
    availableModels,
    onModelChange: (model: ModelDefinition) => {
      setSelectedModel(model);
      resetChat();
    },
    systemPrompt,
    onSystemPromptChange: setSystemPrompt,
    temperature,
    onTemperatureChange: setTemperature,
    onResetChat: resetChat,
    submitDisabled: submitBlocked,
    tokenUsage,
    selectedServers,
    mcpToolsTokenCount: null,
    mcpToolsTokenCountLoading: false,
    connectedServerConfigs: { [serverName]: { name: serverName } },
    systemPromptTokenCount: null,
    systemPromptTokenCountLoading: false,
    mcpPromptResults,
    onChangeMcpPromptResults: setMcpPromptResults,
    compact: isCompact,
  };

  // Check if widget should take over the full container
  // Mobile: both fullscreen and pip take over
  // Tablet: only fullscreen takes over (pip stays floating)
  const isMobileFullTakeover =
    deviceType === "mobile" &&
    (displayMode === "fullscreen" || displayMode === "pip");
  const isTabletFullscreenTakeover =
    deviceType === "tablet" && displayMode === "fullscreen";
  const isWidgetFullTakeover =
    isMobileFullTakeover || isTabletFullscreenTakeover;

  // Thread content
  const threadContent = (
    <>
      {isThreadEmpty ? (
        // Empty state - min-h-0 allows flex child to shrink below content size
        <div className="flex-1 flex items-center justify-center overflow-y-auto overflow-x-hidden px-4 min-h-0">
          <div className="w-full max-w-xl space-y-6 py-8 min-w-0">
            <div className="text-center max-w-md mx-auto">
              <h3 className="text-sm font-semibold text-foreground mb-2">
                Test ChatGPT Apps and MCP Apps
              </h3>
            </div>
            <ChatInput {...sharedChatInputProps} hasMessages={false} />
          </div>
        </div>
      ) : (
        // Thread with messages
        <StickToBottom
          className="relative flex flex-1 flex-col min-h-0"
          resize="smooth"
          initial="smooth"
        >
          <div className="relative flex-1 min-h-0">
            <StickToBottom.Content className="flex flex-col min-h-0">
              <Thread
                messages={messages}
                sendFollowUpMessage={handleSendFollowUp}
                model={selectedModel}
                isLoading={status === "submitted"}
                toolsMetadata={toolsMetadata}
                toolServerMap={toolServerMap}
                onWidgetStateChange={handleWidgetStateChange}
                displayMode={displayMode}
                onDisplayModeChange={onDisplayModeChange}
                onFullscreenChange={setIsWidgetFullscreen}
              />
              {/* Invoking indicator while tool execution is in progress */}
              {isExecuting && executingToolName && (
                <InvokingIndicator
                  toolName={executingToolName}
                  customMessage={invokingMessage}
                />
              )}
              {errorMessage && (
                <div className="px-4 pb-4 pt-4">
                  <ErrorBox
                    message={errorMessage.message}
                    errorDetails={errorMessage.details}
                    onResetChat={resetChat}
                  />
                </div>
              )}
            </StickToBottom.Content>
            <ScrollToBottomButton />
          </div>

          {/* Hide chat input when widget takes over (mobile fullscreen/pip, tablet fullscreen only) */}
          {!isWidgetFullTakeover && (
            <div className="bg-background/80 backdrop-blur-sm border-t border-border flex-shrink-0">
              <div className="p-3">
                <ChatInput {...sharedChatInputProps} hasMessages />
              </div>
            </div>
          )}
        </StickToBottom>
      )}
    </>
  );

  // Device frame container - display mode is passed to widgets via Thread
  return (
    <div className="h-full flex flex-col bg-muted/20 overflow-hidden">
      {/* Device frame header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-background/50 text-xs text-muted-foreground flex-shrink-0">
        {/* Device type toggle - flex-1 to balance with right section */}
        <div className="flex-1 flex justify-start">
          <ToggleGroup
            type="single"
            value={deviceType}
            onValueChange={(v) => v && onDeviceTypeChange?.(v as DeviceType)}
            className="gap-0.5"
          >
            <ToggleGroupItem
              value="mobile"
              aria-label="Mobile"
              title="Mobile (430x932)"
              className="h-7 w-7 p-0 cursor-pointer"
            >
              <Smartphone className="h-3.5 w-3.5" />
            </ToggleGroupItem>
            <ToggleGroupItem
              value="tablet"
              aria-label="Tablet"
              title="Tablet (820x1180)"
              className="h-7 w-7 p-0 cursor-pointer"
            >
              <Tablet className="h-3.5 w-3.5" />
            </ToggleGroupItem>
            <ToggleGroupItem
              value="desktop"
              aria-label="Desktop"
              title="Desktop (1280x800)"
              className="h-7 w-7 p-0 cursor-pointer"
            >
              <Monitor className="h-3.5 w-3.5" />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        {/* Device label, locale, and theme */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <DeviceIcon className="h-3.5 w-3.5" />
            <span>{deviceConfig.label}</span>
            <span className="text-[10px] text-muted-foreground/60">
              ({deviceConfig.width}×{deviceConfig.height})
            </span>
          </div>

          {/* Locale selector */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div>
                <Select value={locale} onValueChange={onLocaleChange}>
                  <SelectTrigger
                    size="sm"
                    className="h-7 w-auto min-w-[70px] text-xs border-none shadow-none bg-transparent hover:bg-accent"
                  >
                    <Globe className="h-3.5 w-3.5" />
                    <SelectValue>{locale}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {LOCALE_OPTIONS.map((option) => (
                      <SelectItem key={option.code} value={option.code}>
                        <span className="flex items-center gap-2">
                          <span>{option.label}</span>
                          <span className="text-muted-foreground text-[10px]">
                            {option.code}
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p className="font-medium">Locale</p>
            </TooltipContent>
          </Tooltip>

          {/* CSP mode selector */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div>
                <Select
                  value={cspMode}
                  onValueChange={(v) => setCspMode(v as CspMode)}
                >
                  <SelectTrigger
                    size="sm"
                    className="h-7 w-auto min-w-[90px] text-xs border-none shadow-none bg-transparent hover:bg-accent"
                  >
                    <Shield className="h-3.5 w-3.5" />
                    <SelectValue>
                      {CSP_MODE_OPTIONS.find((o) => o.mode === cspMode)?.label}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {CSP_MODE_OPTIONS.map((option) => (
                      <SelectItem key={option.mode} value={option.mode}>
                        <span className="flex items-center gap-2">
                          <span className="font-medium">{option.label}</span>
                          <span className="text-muted-foreground text-[10px]">
                            {option.description}
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p className="font-medium">CSP</p>
            </TooltipContent>
          </Tooltip>

          {/* Capabilities toggles */}
          <div className="flex items-center gap-0.5 border-l border-border/50 pl-3 ml-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={capabilities.hover ? "secondary" : "ghost"}
                  size="icon"
                  onClick={() =>
                    setCapabilities({ hover: !capabilities.hover })
                  }
                  className="h-7 w-7"
                >
                  <MousePointer2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p className="font-medium">Hover</p>
                <p className="text-xs text-muted-foreground">
                  {capabilities.hover ? "Enabled" : "Disabled"}
                </p>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={capabilities.touch ? "secondary" : "ghost"}
                  size="icon"
                  onClick={() =>
                    setCapabilities({ touch: !capabilities.touch })
                  }
                  className="h-7 w-7"
                >
                  <Hand className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p className="font-medium">Touch</p>
                <p className="text-xs text-muted-foreground">
                  {capabilities.touch ? "Enabled" : "Disabled"}
                </p>
              </TooltipContent>
            </Tooltip>
          </div>

          {/* Safe area editor */}
          <SafeAreaEditor />

          {/* Theme toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleThemeChange}
                className="h-7 w-7"
              >
                {themeMode === "dark" ? (
                  <Sun className="h-3.5 w-3.5" />
                ) : (
                  <Moon className="h-3.5 w-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {themeMode === "dark" ? "Light mode" : "Dark mode"}
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Right actions - flex-1 to balance with left section */}
        <div className="flex-1 flex items-center justify-end">
          {!isThreadEmpty && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowClearConfirm(true)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Clear chat</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      <ConfirmChatResetDialog
        open={showClearConfirm}
        onCancel={() => setShowClearConfirm(false)}
        onConfirm={handleClearChat}
      />

      {/* Device frame container */}
      <div className="flex-1 flex items-center justify-center p-4 min-h-0 overflow-auto">
        <div
          className="bg-background border border-border rounded-xl shadow-lg flex flex-col overflow-hidden"
          style={{
            width: deviceConfig.width,
            maxWidth: "100%",
            height: isWidgetFullTakeover ? "100%" : deviceConfig.height,
            maxHeight: "100%",
            transform: isWidgetFullscreen ? "none" : "translateZ(0)",
          }}
        >
          {threadContent}
        </div>
      </div>
    </div>
  );
}
