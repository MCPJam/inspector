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
  Clock,
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
  DEVICE_VIEWPORT_CONFIGS,
  type DeviceType,
  type DisplayMode,
  type CspMode,
  type AppProtocol,
} from "@/stores/ui-playground-store";
import { SafeAreaEditor } from "./SafeAreaEditor";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";

/** Device frame configurations - extends shared viewport config with UI properties */
const DEVICE_CONFIGS: Record<
  DeviceType,
  { width: number; height: number; label: string; icon: typeof Smartphone }
> = {
  mobile: { ...DEVICE_VIEWPORT_CONFIGS.mobile, label: "Phone", icon: Smartphone },
  tablet: { ...DEVICE_VIEWPORT_CONFIGS.tablet, label: "Tablet", icon: Tablet },
  desktop: { ...DEVICE_VIEWPORT_CONFIGS.desktop, label: "Desktop", icon: Monitor },
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

/** Common IANA timezones for testing (per SEP-1865 MCP Apps spec) */
const TIMEZONE_OPTIONS = [
  { zone: "America/New_York", label: "New York", offset: "UTC-5/-4" },
  { zone: "America/Chicago", label: "Chicago", offset: "UTC-6/-5" },
  { zone: "America/Denver", label: "Denver", offset: "UTC-7/-6" },
  { zone: "America/Los_Angeles", label: "Los Angeles", offset: "UTC-8/-7" },
  { zone: "America/Sao_Paulo", label: "São Paulo", offset: "UTC-3" },
  { zone: "America/Mexico_City", label: "Mexico City", offset: "UTC-6/-5" },
  { zone: "Europe/London", label: "London", offset: "UTC+0/+1" },
  { zone: "Europe/Paris", label: "Paris", offset: "UTC+1/+2" },
  { zone: "Europe/Berlin", label: "Berlin", offset: "UTC+1/+2" },
  { zone: "Europe/Moscow", label: "Moscow", offset: "UTC+3" },
  { zone: "Asia/Dubai", label: "Dubai", offset: "UTC+4" },
  { zone: "Asia/Kolkata", label: "Mumbai", offset: "UTC+5:30" },
  { zone: "Asia/Singapore", label: "Singapore", offset: "UTC+8" },
  { zone: "Asia/Shanghai", label: "Shanghai", offset: "UTC+8" },
  { zone: "Asia/Tokyo", label: "Tokyo", offset: "UTC+9" },
  { zone: "Asia/Seoul", label: "Seoul", offset: "UTC+9" },
  { zone: "Australia/Sydney", label: "Sydney", offset: "UTC+10/+11" },
  { zone: "Pacific/Auckland", label: "Auckland", offset: "UTC+12/+13" },
  { zone: "UTC", label: "UTC", offset: "UTC+0" },
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
  // Timezone (IANA) per SEP-1865
  timeZone?: string;
  onTimeZoneChange?: (timeZone: string) => void;
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
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  onTimeZoneChange,
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

  // CSP mode from store (ChatGPT Apps)
  const cspMode = useUIPlaygroundStore((s) => s.cspMode);
  const setCspMode = useUIPlaygroundStore((s) => s.setCspMode);

  // CSP mode for MCP Apps (SEP-1865)
  const mcpAppsCspMode = useUIPlaygroundStore((s) => s.mcpAppsCspMode);
  const setMcpAppsCspMode = useUIPlaygroundStore((s) => s.setMcpAppsCspMode);

  // Currently selected protocol (detected from tool metadata)
  const selectedProtocol = useUIPlaygroundStore((s) => s.selectedProtocol);

  // Protocol-aware CSP mode: use the correct store based on detected protocol
  const activeCspMode = selectedProtocol === "mcp-apps" ? mcpAppsCspMode : cspMode;
  const setActiveCspMode = selectedProtocol === "mcp-apps" ? setMcpAppsCspMode : setCspMode;

  // Device capabilities from store
  const capabilities = useUIPlaygroundStore((s) => s.capabilities);
  const setCapabilities = useUIPlaygroundStore((s) => s.setCapabilities);

  // Show ChatGPT Apps controls when: no protocol selected (default) or openai-apps
  const showChatGPTControls =
    selectedProtocol === null || selectedProtocol === "openai-apps";
  // Show MCP Apps controls when mcp-apps protocol is selected
  const showMCPAppsControls = selectedProtocol === "mcp-apps";

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
      <div className="relative flex items-center justify-center px-3 py-2 border-b border-border bg-background/50 text-xs text-muted-foreground flex-shrink-0">
        {/* All controls centered */}
        <div className="flex items-center gap-4">
          {/* ChatGPT Apps controls */}
          {showChatGPTControls && (
            <>
              {/* Device type selector */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <div>
                    <Select
                      value={deviceType}
                      onValueChange={(v) => onDeviceTypeChange?.(v as DeviceType)}
                    >
                      <SelectTrigger
                        size="sm"
                        className="h-7 w-auto min-w-[100px] text-xs border-none shadow-none bg-transparent hover:bg-accent"
                      >
                        <DeviceIcon className="h-3.5 w-3.5" />
                        <SelectValue>{deviceConfig.label}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.entries(DEVICE_CONFIGS) as [DeviceType, typeof deviceConfig][]).map(
                          ([type, config]) => {
                            const Icon = config.icon;
                            return (
                              <SelectItem key={type} value={type}>
                                <span className="flex items-center gap-2">
                                  <Icon className="h-3.5 w-3.5" />
                                  <span>{config.label}</span>
                                  <span className="text-muted-foreground text-[10px]">
                                    ({config.width}×{config.height})
                                  </span>
                                </span>
                              </SelectItem>
                            );
                          }
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="font-medium">Device</p>
                </TooltipContent>
              </Tooltip>

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

              {/* CSP mode selector - uses protocol-aware store */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <div>
                    <Select
                      value={activeCspMode}
                      onValueChange={(v) => setActiveCspMode(v as CspMode)}
                    >
                      <SelectTrigger
                        size="sm"
                        className="h-7 w-auto min-w-[90px] text-xs border-none shadow-none bg-transparent hover:bg-accent"
                      >
                        <Shield className="h-3.5 w-3.5" />
                        <SelectValue>
                          {CSP_MODE_OPTIONS.find((o) => o.mode === activeCspMode)?.label}
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
              <div className="flex items-center gap-0.5">
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
              <Tooltip>
                <TooltipTrigger asChild>
                  <div>
                    <SafeAreaEditor />
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="font-medium">Safe Area</p>
                </TooltipContent>
              </Tooltip>
            </>
          )}

          {/* MCP Apps controls (SEP-1865) */}
          {showMCPAppsControls && (
            <>
              {/* Device type selector */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <div>
                    <Select
                      value={deviceType}
                      onValueChange={(v) => onDeviceTypeChange?.(v as DeviceType)}
                    >
                      <SelectTrigger
                        size="sm"
                        className="h-7 w-auto min-w-[100px] text-xs border-none shadow-none bg-transparent hover:bg-accent"
                      >
                        <DeviceIcon className="h-3.5 w-3.5" />
                        <SelectValue>{deviceConfig.label}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.entries(DEVICE_CONFIGS) as [DeviceType, typeof deviceConfig][]).map(
                          ([type, config]) => {
                            const Icon = config.icon;
                            return (
                              <SelectItem key={type} value={type}>
                                <span className="flex items-center gap-2">
                                  <Icon className="h-3.5 w-3.5" />
                                  <span>{config.label}</span>
                                  <span className="text-muted-foreground text-[10px]">
                                    ({config.width}×{config.height})
                                  </span>
                                </span>
                              </SelectItem>
                            );
                          }
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="font-medium">Device</p>
                </TooltipContent>
              </Tooltip>

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

              {/* Timezone selector (SEP-1865) */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <div>
                    <Select value={timeZone} onValueChange={onTimeZoneChange}>
                      <SelectTrigger
                        size="sm"
                        className="h-7 w-auto min-w-[90px] text-xs border-none shadow-none bg-transparent hover:bg-accent"
                      >
                        <Clock className="h-3.5 w-3.5" />
                        <SelectValue>
                          {TIMEZONE_OPTIONS.find((o) => o.zone === timeZone)?.label || timeZone}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {TIMEZONE_OPTIONS.map((option) => (
                          <SelectItem key={option.zone} value={option.zone}>
                            <span className="flex items-center gap-2">
                              <span>{option.label}</span>
                              <span className="text-muted-foreground text-[10px]">
                                {option.offset}
                              </span>
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="font-medium">Timezone</p>
                </TooltipContent>
              </Tooltip>

              {/* CSP mode selector */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <div>
                    <Select
                      value={mcpAppsCspMode}
                      onValueChange={(v) => setMcpAppsCspMode(v as CspMode)}
                    >
                      <SelectTrigger
                        size="sm"
                        className="h-7 w-auto min-w-[90px] text-xs border-none shadow-none bg-transparent hover:bg-accent"
                      >
                        <Shield className="h-3.5 w-3.5" />
                        <SelectValue>
                          {CSP_MODE_OPTIONS.find((o) => o.mode === mcpAppsCspMode)?.label}
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
              <div className="flex items-center gap-0.5">
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
              <Tooltip>
                <TooltipTrigger asChild>
                  <div>
                    <SafeAreaEditor />
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="font-medium">Safe Area</p>
                </TooltipContent>
              </Tooltip>
            </>
          )}

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

        {/* Right actions - absolutely positioned */}
        {!isThreadEmpty && (
          <div className="absolute right-3">
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
          </div>
        )}
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
