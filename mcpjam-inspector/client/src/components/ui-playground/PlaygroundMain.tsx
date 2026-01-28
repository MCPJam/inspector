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
  Settings2,
} from "lucide-react";
import { useAuth } from "@workos-inc/authkit-react";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { ModelDefinition } from "@/shared/types";
import { cn } from "@/lib/utils";
import { Thread } from "@/components/chat-v2/thread";
import { ChatInput } from "@/components/chat-v2/chat-input";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { formatErrorMessage } from "@/components/chat-v2/shared/chat-helpers";
import { ErrorBox } from "@/components/chat-v2/error";
import { ConfirmChatResetDialog } from "@/components/chat-v2/chat-input/dialogs/confirm-chat-reset-dialog";
import { useChatSession } from "@/hooks/use-chat-session";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { updateThemeMode } from "@/lib/theme-utils";
import { createDeterministicToolMessages } from "./playground-helpers";
import type { MCPPromptResult } from "@/components/chat-v2/chat-input/prompts/mcp-prompts-popover";
import type { SkillResult } from "@/components/chat-v2/chat-input/skills/skill-types";
import {
  useUIPlaygroundStore,
  DEVICE_VIEWPORT_CONFIGS,
  type DeviceType,
  type DisplayMode,
  type CspMode,
} from "@/stores/ui-playground-store";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SafeAreaEditor } from "./SafeAreaEditor";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
import { MCPJamFreeModelsPrompt } from "@/components/chat-v2/mcpjam-free-models-prompt";
import { FullscreenChatOverlay } from "@/components/chat-v2/fullscreen-chat-overlay";
import { useSharedAppState } from "@/state/app-state-context";
import { UIType } from "@/lib/mcp-ui/mcp-apps-utils";

/** Device frame configurations - extends shared viewport config with UI properties */
const PRESET_DEVICE_CONFIGS: Record<
  Exclude<DeviceType, "custom">,
  { width: number; height: number; label: string; icon: typeof Smartphone }
> = {
  mobile: {
    ...DEVICE_VIEWPORT_CONFIGS.mobile,
    label: "Phone",
    icon: Smartphone,
  },
  tablet: { ...DEVICE_VIEWPORT_CONFIGS.tablet, label: "Tablet", icon: Tablet },
  desktop: {
    ...DEVICE_VIEWPORT_CONFIGS.desktop,
    label: "Desktop",
    icon: Monitor,
  },
};

/** Custom device config - dimensions come from store */
const CUSTOM_DEVICE_BASE = {
  label: "Custom",
  icon: Settings2,
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
  const { signUp } = useAuth();
  const posthog = usePostHog();
  const clearLogs = useTrafficLogStore((s) => s.clear);
  const [input, setInput] = useState("");
  const [mcpPromptResults, setMcpPromptResults] = useState<MCPPromptResult[]>(
    [],
  );
  const [skillResults, setSkillResults] = useState<SkillResult[]>([]);
  const [modelContextQueue, setModelContextQueue] = useState<
    {
      toolCallId: string;
      context: {
        content?: ContentBlock[];
        structuredContent?: Record<string, unknown>;
      };
    }[]
  >([]);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [isWidgetFullscreen, setIsWidgetFullscreen] = useState(false);
  const [isFullscreenChatOpen, setIsFullscreenChatOpen] = useState(false);
  const [devicePopoverOpen, setDevicePopoverOpen] = useState(false);
  const [localePopoverOpen, setLocalePopoverOpen] = useState(false);
  const [cspPopoverOpen, setCspPopoverOpen] = useState(false);
  const [timezonePopoverOpen, setTimezonePopoverOpen] = useState(false);

  // Custom viewport from store
  const customViewport = useUIPlaygroundStore((s) => s.customViewport);
  const setCustomViewport = useUIPlaygroundStore((s) => s.setCustomViewport);

  // Device config - use custom dimensions from store for custom type
  const deviceConfig = useMemo(() => {
    if (deviceType === "custom") {
      return {
        ...CUSTOM_DEVICE_BASE,
        width: customViewport.width,
        height: customViewport.height,
      };
    }
    return PRESET_DEVICE_CONFIGS[deviceType];
  }, [deviceType, customViewport]);
  const DeviceIcon = deviceConfig.icon;

  // Theme handling
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const setThemeMode = usePreferencesStore((s) => s.setThemeMode);

  const handleThemeChange = useCallback(() => {
    const newTheme = themeMode === "dark" ? "light" : "dark";
    updateThemeMode(newTheme);
    setThemeMode(newTheme);
  }, [themeMode, setThemeMode]);

  const { servers } = useSharedAppState();
  const selectedServers = useMemo(
    () =>
      serverName && servers[serverName]?.connectionStatus === "connected"
        ? [serverName]
        : [],
    [serverName, servers],
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
  const activeCspMode =
    selectedProtocol === "mcp-apps" ? mcpAppsCspMode : cspMode;
  const setActiveCspMode =
    selectedProtocol === "mcp-apps" ? setMcpAppsCspMode : setCspMode;

  // Device capabilities from store
  const capabilities = useUIPlaygroundStore((s) => s.capabilities);
  const setCapabilities = useUIPlaygroundStore((s) => s.setCapabilities);

  // Show ChatGPT Apps controls when: no protocol selected (default) or openai-apps
  const showChatGPTControls =
    selectedProtocol === null || selectedProtocol === UIType.OPENAI_SDK;
  // Show MCP Apps controls when mcp-apps protocol is selected
  const showMCPAppsControls = selectedProtocol === UIType.MCP_APPS;

  // Check if thread is empty
  const isThreadEmpty = !messages.some(
    (msg) => msg.role === "user" || msg.role === "assistant",
  );

  // Keyboard shortcut for clear chat (Cmd/Ctrl+Shift+K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "k"
      ) {
        e.preventDefault();
        if (!isThreadEmpty) {
          setShowClearConfirm(true);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isThreadEmpty]);

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

  // Handle model context updates from widgets (SEP-1865 ui/update-model-context)
  const handleModelContextUpdate = useCallback(
    (
      toolCallId: string,
      context: {
        content?: ContentBlock[];
        structuredContent?: Record<string, unknown>;
      },
    ) => {
      // Queue model context to be included in next message
      setModelContextQueue((prev) => {
        // Remove any existing context from same widget (overwrite pattern per SEP-1865)
        const filtered = prev.filter((item) => item.toolCallId !== toolCallId);
        return [...filtered, { toolCallId, context }];
      });
    },
    [],
  );

  // Handle clear chat
  const handleClearChat = useCallback(() => {
    resetChat();
    clearLogs();
    setShowClearConfirm(false);
  }, [resetChat, clearLogs]);

  // Placeholder text
  let placeholder = "Ask something to render UI...";
  if (isAuthLoading) {
    placeholder = "Loading...";
  } else if (disableForAuthentication) {
    placeholder = "Sign in to use chat";
  }

  const shouldShowUpsell = disableForAuthentication && !isAuthLoading;
  const handleSignUp = () => {
    posthog.capture("sign_up_button_clicked", {
      location: "app_builder_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
    signUp();
  };

  // Submit handler
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      (input.trim() || mcpPromptResults.length > 0) &&
      status === "ready" &&
      !submitBlocked
    ) {
      if (displayMode === "fullscreen" && isWidgetFullscreen) {
        setIsFullscreenChatOpen(true);
      }
      posthog.capture("app_builder_send_message", {
        location: "app_builder_tab",
        platform: detectPlatform(),
        environment: detectEnvironment(),
        model_id: selectedModel?.id ?? null,
        model_name: selectedModel?.name ?? null,
        model_provider: selectedModel?.provider ?? null,
      });

      // Include any pending model context from widgets (SEP-1865 ui/update-model-context)
      // Sent as "user" messages for compatibility with model provider APIs
      const contextMessages = modelContextQueue.map(
        ({ toolCallId, context }) => ({
          id: `model-context-${toolCallId}-${Date.now()}`,
          role: "user" as const,
          parts: [
            {
              type: "text" as const,
              text: `Widget ${toolCallId} context: ${JSON.stringify(context)}`,
            },
          ],
          metadata: {
            source: "widget-model-context",
            toolCallId,
          },
        }),
      );

      if (contextMessages.length > 0) {
        setMessages((prev) => [...prev, ...contextMessages]);
      }

      sendMessage({ text: input });
      setInput("");
      setMcpPromptResults([]);
      setModelContextQueue([]); // Clear after sending
    }
  };

  const errorMessage = formatErrorMessage(error);
  const inputDisabled = status !== "ready" || submitBlocked;

  // Compact mode for smaller devices or narrow custom viewports
  const isCompact = useMemo(() => {
    if (deviceType === "mobile" || deviceType === "tablet") return true;
    if (deviceType === "custom" && customViewport.width < 500) return true;
    return false;
  }, [deviceType, customViewport.width]);

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
    skillResults,
    onChangeSkillResults: setSkillResults,
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

  const showFullscreenChatOverlay =
    displayMode === "fullscreen" &&
    isWidgetFullscreen &&
    deviceType === "desktop" &&
    !isWidgetFullTakeover;

  useEffect(() => {
    if (!showFullscreenChatOverlay) setIsFullscreenChatOpen(false);
  }, [showFullscreenChatOverlay]);

  // Thread content - single ChatInput that persists across empty/non-empty states
  const threadContent = (
    <div className="relative flex flex-col flex-1 min-h-0">
      {isThreadEmpty ? (
        // Empty state - centered welcome message
        <div className="flex-1 flex items-center justify-center overflow-y-auto overflow-x-hidden px-4 min-h-0">
          <div className="text-center max-w-md mx-auto space-y-6 py-8">
            {isAuthLoading ? (
              <div className="space-y-4">
                <div className="mx-auto h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
                <p className="text-sm text-muted-foreground">Loading...</p>
              </div>
            ) : shouldShowUpsell ? (
              <MCPJamFreeModelsPrompt onSignUp={handleSignUp} />
            ) : (
              <h3 className="text-sm font-semibold text-foreground mb-2">
                Test ChatGPT Apps and MCP Apps
              </h3>
            )}
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
                onModelContextUpdate={handleModelContextUpdate}
                displayMode={displayMode}
                onDisplayModeChange={onDisplayModeChange}
                onFullscreenChange={setIsWidgetFullscreen}
                selectedProtocolOverrideIfBothExists={
                  selectedProtocol ?? undefined
                }
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
        </StickToBottom>
      )}

      {/* Single ChatInput that persists - hidden when widget takes over */}
      {!isWidgetFullTakeover && !showFullscreenChatOverlay && (
        <div
          className={cn(
            "flex-shrink-0 max-w-xl mx-auto w-full",
            isThreadEmpty
              ? "px-4 pb-4"
              : "bg-background/80 backdrop-blur-sm p-3",
          )}
        >
          <ChatInput {...sharedChatInputProps} hasMessages={!isThreadEmpty} />
        </div>
      )}

      {/* Fullscreen overlay chat (input pinned + collapsible thread) */}
      {showFullscreenChatOverlay && (
        <FullscreenChatOverlay
          messages={messages}
          open={isFullscreenChatOpen}
          onOpenChange={setIsFullscreenChatOpen}
          input={input}
          onInputChange={setInput}
          placeholder={placeholder}
          disabled={inputDisabled}
          canSend={
            status === "ready" && !submitBlocked && input.trim().length > 0
          }
          isThinking={status === "submitted"}
          onSend={() => {
            sendMessage({ text: input });
            setInput("");
            setMcpPromptResults([]);
          }}
        />
      )}
    </div>
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
              {/* Device type selector with custom dimensions */}
              <Popover
                open={devicePopoverOpen}
                onOpenChange={setDevicePopoverOpen}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs gap-1.5"
                      >
                        <DeviceIcon className="h-3.5 w-3.5" />
                        <span>{deviceConfig.label}</span>
                        <span className="text-muted-foreground text-[10px]">
                          {deviceConfig.width}×{deviceConfig.height}
                        </span>
                      </Button>
                    </PopoverTrigger>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="font-medium">Device</p>
                  </TooltipContent>
                </Tooltip>
                <PopoverContent className="w-56 p-2" align="start">
                  <div className="space-y-2">
                    {/* Preset devices */}
                    {(
                      Object.entries(PRESET_DEVICE_CONFIGS) as [
                        Exclude<DeviceType, "custom">,
                        (typeof PRESET_DEVICE_CONFIGS)[Exclude<
                          DeviceType,
                          "custom"
                        >],
                      ][]
                    ).map(([type, config]) => {
                      const Icon = config.icon;
                      const isSelected = deviceType === type;
                      return (
                        <button
                          key={type}
                          onClick={() => {
                            onDeviceTypeChange?.(type);
                            setDevicePopoverOpen(false);
                          }}
                          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-accent transition-colors ${
                            isSelected ? "bg-accent text-accent-foreground" : ""
                          }`}
                        >
                          <Icon className="h-3.5 w-3.5" />
                          <span>{config.label}</span>
                          <span className="text-muted-foreground text-[10px] ml-auto">
                            {config.width}×{config.height}
                          </span>
                        </button>
                      );
                    })}

                    {/* Custom option */}
                    <button
                      onClick={() => onDeviceTypeChange?.("custom")}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-accent transition-colors ${
                        deviceType === "custom"
                          ? "bg-accent text-accent-foreground"
                          : ""
                      }`}
                    >
                      <Settings2 className="h-3.5 w-3.5" />
                      <span>Custom</span>
                      <span className="text-muted-foreground text-[10px] ml-auto">
                        {customViewport.width}×{customViewport.height}
                      </span>
                    </button>

                    {/* Custom dimension inputs - only show when custom is selected */}
                    {deviceType === "custom" && (
                      <div className="grid grid-cols-2 gap-2 pt-1">
                        <div className="space-y-1">
                          <Label
                            htmlFor="custom-width"
                            className="text-[10px] text-muted-foreground"
                          >
                            Width
                          </Label>
                          <Input
                            id="custom-width"
                            type="number"
                            min={100}
                            max={2560}
                            defaultValue={customViewport.width}
                            key={`w-${customViewport.width}`}
                            onBlur={(e) => {
                              const val = parseInt(e.target.value) || 100;
                              setCustomViewport({
                                width: Math.max(100, Math.min(2560, val)),
                              });
                            }}
                            className="h-7 text-xs [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label
                            htmlFor="custom-height"
                            className="text-[10px] text-muted-foreground"
                          >
                            Height
                          </Label>
                          <Input
                            id="custom-height"
                            type="number"
                            min={100}
                            max={2560}
                            defaultValue={customViewport.height}
                            key={`h-${customViewport.height}`}
                            onBlur={(e) => {
                              const val = parseInt(e.target.value) || 100;
                              setCustomViewport({
                                height: Math.max(100, Math.min(2560, val)),
                              });
                            }}
                            className="h-7 text-xs [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </PopoverContent>
              </Popover>

              {/* Locale selector */}
              <Popover
                open={localePopoverOpen}
                onOpenChange={setLocalePopoverOpen}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs gap-1.5"
                      >
                        <Globe className="h-3.5 w-3.5" />
                        <span>{locale}</span>
                      </Button>
                    </PopoverTrigger>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="font-medium">Locale</p>
                  </TooltipContent>
                </Tooltip>
                <PopoverContent className="w-48 p-2" align="start">
                  <div className="space-y-1">
                    {LOCALE_OPTIONS.map((option) => (
                      <button
                        key={option.code}
                        onClick={() => {
                          onLocaleChange?.(option.code);
                          setLocalePopoverOpen(false);
                        }}
                        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-accent transition-colors ${
                          locale === option.code
                            ? "bg-accent text-accent-foreground"
                            : ""
                        }`}
                      >
                        <span>{option.label}</span>
                        <span className="text-muted-foreground text-[10px] ml-auto">
                          {option.code}
                        </span>
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>

              {/* CSP mode selector - uses protocol-aware store */}
              <Popover open={cspPopoverOpen} onOpenChange={setCspPopoverOpen}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs gap-1.5"
                      >
                        <Shield className="h-3.5 w-3.5" />
                        <span>
                          {
                            CSP_MODE_OPTIONS.find(
                              (o) => o.mode === activeCspMode,
                            )?.label
                          }
                        </span>
                      </Button>
                    </PopoverTrigger>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="font-medium">CSP</p>
                  </TooltipContent>
                </Tooltip>
                <PopoverContent className="w-56 p-2" align="start">
                  <div className="space-y-1">
                    {CSP_MODE_OPTIONS.map((option) => (
                      <button
                        key={option.mode}
                        onClick={() => {
                          setActiveCspMode(option.mode);
                          setCspPopoverOpen(false);
                        }}
                        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-accent transition-colors ${
                          activeCspMode === option.mode
                            ? "bg-accent text-accent-foreground"
                            : ""
                        }`}
                      >
                        <span className="font-medium">{option.label}</span>
                        <span className="text-muted-foreground text-[10px] ml-auto">
                          {option.description}
                        </span>
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>

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
              {/* Device type selector with custom dimensions */}
              <Popover
                open={devicePopoverOpen}
                onOpenChange={setDevicePopoverOpen}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs gap-1.5"
                      >
                        <DeviceIcon className="h-3.5 w-3.5" />
                        <span>{deviceConfig.label}</span>
                        <span className="text-muted-foreground text-[10px]">
                          {deviceConfig.width}×{deviceConfig.height}
                        </span>
                      </Button>
                    </PopoverTrigger>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="font-medium">Device</p>
                  </TooltipContent>
                </Tooltip>
                <PopoverContent className="w-56 p-2" align="start">
                  <div className="space-y-2">
                    {/* Preset devices */}
                    {(
                      Object.entries(PRESET_DEVICE_CONFIGS) as [
                        Exclude<DeviceType, "custom">,
                        (typeof PRESET_DEVICE_CONFIGS)[Exclude<
                          DeviceType,
                          "custom"
                        >],
                      ][]
                    ).map(([type, config]) => {
                      const Icon = config.icon;
                      const isSelected = deviceType === type;
                      return (
                        <button
                          key={type}
                          onClick={() => {
                            onDeviceTypeChange?.(type);
                            setDevicePopoverOpen(false);
                          }}
                          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-accent transition-colors ${
                            isSelected ? "bg-accent text-accent-foreground" : ""
                          }`}
                        >
                          <Icon className="h-3.5 w-3.5" />
                          <span>{config.label}</span>
                          <span className="text-muted-foreground text-[10px] ml-auto">
                            {config.width}×{config.height}
                          </span>
                        </button>
                      );
                    })}

                    {/* Custom option */}
                    <button
                      onClick={() => onDeviceTypeChange?.("custom")}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-accent transition-colors ${
                        deviceType === "custom"
                          ? "bg-accent text-accent-foreground"
                          : ""
                      }`}
                    >
                      <Settings2 className="h-3.5 w-3.5" />
                      <span>Custom</span>
                      <span className="text-muted-foreground text-[10px] ml-auto">
                        {customViewport.width}×{customViewport.height}
                      </span>
                    </button>

                    {/* Custom dimension inputs - only show when custom is selected */}
                    {deviceType === "custom" && (
                      <div className="grid grid-cols-2 gap-2 pt-1">
                        <div className="space-y-1">
                          <Label
                            htmlFor="custom-width-mcp"
                            className="text-[10px] text-muted-foreground"
                          >
                            Width
                          </Label>
                          <Input
                            id="custom-width-mcp"
                            type="number"
                            min={100}
                            max={2560}
                            defaultValue={customViewport.width}
                            key={`w-mcp-${customViewport.width}`}
                            onBlur={(e) => {
                              const val = parseInt(e.target.value) || 100;
                              setCustomViewport({
                                width: Math.max(100, Math.min(2560, val)),
                              });
                            }}
                            className="h-7 text-xs [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label
                            htmlFor="custom-height-mcp"
                            className="text-[10px] text-muted-foreground"
                          >
                            Height
                          </Label>
                          <Input
                            id="custom-height-mcp"
                            type="number"
                            min={100}
                            max={2560}
                            defaultValue={customViewport.height}
                            key={`h-mcp-${customViewport.height}`}
                            onBlur={(e) => {
                              const val = parseInt(e.target.value) || 100;
                              setCustomViewport({
                                height: Math.max(100, Math.min(2560, val)),
                              });
                            }}
                            className="h-7 text-xs [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </PopoverContent>
              </Popover>

              {/* Locale selector */}
              <Popover
                open={localePopoverOpen}
                onOpenChange={setLocalePopoverOpen}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs gap-1.5"
                      >
                        <Globe className="h-3.5 w-3.5" />
                        <span>{locale}</span>
                      </Button>
                    </PopoverTrigger>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="font-medium">Locale</p>
                  </TooltipContent>
                </Tooltip>
                <PopoverContent className="w-48 p-2" align="start">
                  <div className="space-y-1">
                    {LOCALE_OPTIONS.map((option) => (
                      <button
                        key={option.code}
                        onClick={() => {
                          onLocaleChange?.(option.code);
                          setLocalePopoverOpen(false);
                        }}
                        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-accent transition-colors ${
                          locale === option.code
                            ? "bg-accent text-accent-foreground"
                            : ""
                        }`}
                      >
                        <span>{option.label}</span>
                        <span className="text-muted-foreground text-[10px] ml-auto">
                          {option.code}
                        </span>
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>

              {/* Timezone selector (SEP-1865) */}
              <Popover
                open={timezonePopoverOpen}
                onOpenChange={setTimezonePopoverOpen}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs gap-1.5"
                      >
                        <Clock className="h-3.5 w-3.5" />
                        <span>
                          {TIMEZONE_OPTIONS.find((o) => o.zone === timeZone)
                            ?.label || timeZone}
                        </span>
                      </Button>
                    </PopoverTrigger>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="font-medium">Timezone</p>
                  </TooltipContent>
                </Tooltip>
                <PopoverContent className="w-56 p-2" align="start">
                  <div className="space-y-1">
                    {TIMEZONE_OPTIONS.map((option) => (
                      <button
                        key={option.zone}
                        onClick={() => {
                          onTimeZoneChange?.(option.zone);
                          setTimezonePopoverOpen(false);
                        }}
                        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-accent transition-colors ${
                          timeZone === option.zone
                            ? "bg-accent text-accent-foreground"
                            : ""
                        }`}
                      >
                        <span>{option.label}</span>
                        <span className="text-muted-foreground text-[10px] ml-auto">
                          {option.offset}
                        </span>
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>

              {/* CSP mode selector */}
              <Popover open={cspPopoverOpen} onOpenChange={setCspPopoverOpen}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs gap-1.5"
                      >
                        <Shield className="h-3.5 w-3.5" />
                        <span>
                          {
                            CSP_MODE_OPTIONS.find(
                              (o) => o.mode === mcpAppsCspMode,
                            )?.label
                          }
                        </span>
                      </Button>
                    </PopoverTrigger>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="font-medium">CSP</p>
                  </TooltipContent>
                </Tooltip>
                <PopoverContent className="w-56 p-2" align="start">
                  <div className="space-y-1">
                    {CSP_MODE_OPTIONS.map((option) => (
                      <button
                        key={option.mode}
                        onClick={() => {
                          setMcpAppsCspMode(option.mode);
                          setCspPopoverOpen(false);
                        }}
                        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-accent transition-colors ${
                          mcpAppsCspMode === option.mode
                            ? "bg-accent text-accent-foreground"
                            : ""
                        }`}
                      >
                        <span className="font-medium">{option.label}</span>
                        <span className="text-muted-foreground text-[10px] ml-auto">
                          {option.description}
                        </span>
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>

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
              <TooltipContent>
                <p>Clear chat</p>
                <p className="text-xs text-muted-foreground">
                  {navigator.platform.includes("Mac") ? "⌘⇧K" : "Ctrl+Shift+K"}
                </p>
              </TooltipContent>
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
          className="relative bg-background border border-border rounded-xl shadow-lg flex flex-col overflow-hidden"
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
