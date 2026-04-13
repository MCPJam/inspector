import {
  type CSSProperties,
  useEffect,
  useMemo,
  useRef,
  type ComponentProps,
  type HTMLAttributes,
  type MutableRefObject,
  type Ref,
  type RefObject,
} from "react";
import type { UIMessage } from "@ai-sdk/react";
import { motion, useReducedMotion } from "framer-motion";
import { MessageView } from "./message-view";
import type { ModelDefinition } from "@/shared/types";
import type { DisplayMode } from "@/stores/ui-playground-store";
import type { ToolServerMap } from "@/lib/apis/mcp-tools-api";
import type { UIType } from "@/lib/mcp-ui/mcp-apps-utils";
import { cn } from "@/lib/utils";
import {
  type LoadingIndicatorVariant,
  useResolvedLoadingIndicatorVariant,
} from "@/components/chat-v2/shared/loading-indicator-content";

const NOOP = (..._args: unknown[]) => {};
const TRANSCRIPT_SCROLL_SETTLE_MS = 120;
const TRANSCRIPT_SCROLL_MAX_OBSERVE_MS = 1500;
const TRANSCRIPT_TALL_MESSAGE_RATIO = 0.55;
const TRANSCRIPT_TOP_INSET_MIN_PX = 12;
const TRANSCRIPT_TOP_INSET_MAX_PX = 24;
const TRANSCRIPT_MESSAGE_VISIBILITY_STYLE: CSSProperties = {
  contentVisibility: "auto",
  containIntrinsicSize: "0 160px",
};

type MessageWrapperArgs = {
  message: UIMessage;
  isFocused: boolean;
  isHighlighted: boolean;
};

type MessageWrapperProps = HTMLAttributes<HTMLDivElement> &
  Record<string, unknown>;

type MessageViewPassthroughProps = Omit<
  ComponentProps<typeof MessageView>,
  | "message"
  | "model"
  | "onSendFollowUp"
  | "toolsMetadata"
  | "toolServerMap"
  | "pipWidgetId"
  | "fullscreenWidgetId"
  | "onRequestPip"
  | "onExitPip"
  | "onRequestFullscreen"
  | "onExitFullscreen"
>;

export interface TranscriptThreadProps extends MessageViewPassthroughProps {
  messages: UIMessage[];
  model: ModelDefinition;
  sendFollowUpMessage?: (text: string) => void;
  toolsMetadata: Record<string, Record<string, any>>;
  toolServerMap: ToolServerMap;
  pipWidgetId?: string | null;
  fullscreenWidgetId?: string | null;
  onRequestPip?: (toolCallId: string) => void;
  onExitPip?: (toolCallId: string) => void;
  onRequestFullscreen?: (toolCallId: string) => void;
  onExitFullscreen?: (toolCallId: string) => void;
  displayMode?: DisplayMode;
  onDisplayModeChange?: (mode: DisplayMode) => void;
  selectedProtocolOverrideIfBothExists?: UIType;
  focusMessageId?: string | null;
  highlightedMessageIds?: string[];
  navigationKey?: string | number | null;
  viewportRef?: RefObject<HTMLElement | null>;
  transcriptRef?: Ref<HTMLDivElement>;
  contentClassName?: string;
  isLoading?: boolean;
  loadingIndicatorVariant?: LoadingIndicatorVariant;
  lastRenderableMessageId?: string | null;
  getMessageWrapperProps?: (
    args: MessageWrapperArgs,
  ) => MessageWrapperProps | undefined;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T) {
  if (!ref) return;
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  (ref as MutableRefObject<T>).current = value;
}

function findNearestScrollableAncestor(
  element: HTMLElement,
): HTMLElement | null {
  let container: HTMLElement | null = element.parentElement;

  while (container) {
    const { overflowY } = getComputedStyle(container);
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      container.scrollHeight > container.clientHeight
    ) {
      return container;
    }
    container = container.parentElement;
  }

  return null;
}

function resolveScrollViewport(
  element: HTMLElement,
  viewportRef?: RefObject<HTMLElement | null>,
): HTMLElement | null {
  return viewportRef?.current ?? findNearestScrollableAncestor(element);
}

function scrollMessageToViewportPosition(params: {
  behavior: ScrollBehavior;
  element: HTMLElement;
  viewportRef?: RefObject<HTMLElement | null>;
}) {
  const viewport = resolveScrollViewport(params.element, params.viewportRef);
  if (!viewport) {
    params.element.scrollIntoView({
      block: "center",
      behavior: params.behavior,
    });
    return;
  }

  const targetRect = params.element.getBoundingClientRect();
  const viewportRect = viewport.getBoundingClientRect();
  const topInset = Math.min(
    TRANSCRIPT_TOP_INSET_MAX_PX,
    Math.max(
      TRANSCRIPT_TOP_INSET_MIN_PX,
      Math.round(viewport.clientHeight * 0.08),
    ),
  );
  const centeredOffset = Math.max(
    0,
    (viewport.clientHeight -
      Math.min(targetRect.height, viewport.clientHeight)) /
      2,
  );
  const shouldTopAnchor =
    targetRect.height >= viewport.clientHeight * TRANSCRIPT_TALL_MESSAGE_RATIO;
  const desiredTop =
    viewportRect.top + (shouldTopAnchor ? topInset : centeredOffset);
  const correction = targetRect.top - desiredTop;
  const maxScrollTop = Math.max(
    0,
    viewport.scrollHeight - viewport.clientHeight,
  );
  const nextScrollTop = Math.min(
    maxScrollTop,
    Math.max(0, viewport.scrollTop + correction),
  );

  viewport.scrollTo({
    top: nextScrollTop,
    behavior: params.behavior,
  });
}

export function TranscriptThread({
  messages,
  model,
  sendFollowUpMessage = NOOP,
  toolsMetadata,
  toolServerMap,
  onWidgetStateChange,
  onModelContextUpdate,
  pipWidgetId = null,
  fullscreenWidgetId = null,
  onRequestPip = NOOP,
  onExitPip = NOOP,
  onRequestFullscreen = NOOP,
  onExitFullscreen = NOOP,
  displayMode,
  onDisplayModeChange,
  selectedProtocolOverrideIfBothExists,
  onToolApprovalResponse,
  toolRenderOverrides,
  showSaveViewButton = true,
  minimalMode = false,
  interactive = true,
  reasoningDisplayMode = "inline",
  focusMessageId = null,
  highlightedMessageIds = [],
  navigationKey = null,
  viewportRef,
  transcriptRef,
  contentClassName,
  isLoading = false,
  loadingIndicatorVariant,
  lastRenderableMessageId = null,
  getMessageWrapperProps,
}: TranscriptThreadProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const shouldReduceMotion = useReducedMotion();
  const resolvedLoadingIndicatorVariant = useResolvedLoadingIndicatorVariant(
    loadingIndicatorVariant,
    {
      modelProvider: model.provider,
    },
  );
  const highlightedMessageIdSet = useMemo(
    () => new Set(highlightedMessageIds),
    [highlightedMessageIds],
  );
  const shouldUseContentVisibility =
    focusMessageId === null && highlightedMessageIds.length === 0;

  useEffect(() => {
    if (!focusMessageId) {
      return;
    }

    let cancelled = false;
    let rafId: number | null = null;
    let settleTimer: number | null = null;
    let maxObserveTimer: number | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let mutationObserver: MutationObserver | null = null;

    const clearScheduledScroll = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };

    const clearSettleTimer = () => {
      if (settleTimer !== null) {
        window.clearTimeout(settleTimer);
        settleTimer = null;
      }
    };

    const clearMaxObserveTimer = () => {
      if (maxObserveTimer !== null) {
        window.clearTimeout(maxObserveTimer);
        maxObserveTimer = null;
      }
    };

    const disconnectObservers = () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      resizeObserver = null;
      mutationObserver = null;
      clearSettleTimer();
      clearMaxObserveTimer();
    };

    const scrollTarget = (behavior: ScrollBehavior) => {
      if (cancelled) return;
      const targetElement = messageRefs.current[focusMessageId];
      if (!targetElement) return;
      scrollMessageToViewportPosition({
        behavior,
        element: targetElement,
        viewportRef,
      });
    };

    const scheduleScroll = (behavior: ScrollBehavior) => {
      clearScheduledScroll();
      rafId = requestAnimationFrame(() => {
        rafId = null;
        scrollTarget(behavior);
      });
    };

    const finishObserving = () => {
      disconnectObservers();
    };

    const scheduleSettleCheck = () => {
      clearSettleTimer();
      settleTimer = window.setTimeout(() => {
        settleTimer = null;
        scheduleScroll("auto");
        finishObserving();
      }, TRANSCRIPT_SCROLL_SETTLE_MS);
    };

    scheduleScroll("smooth");

    const targetElement = messageRefs.current[focusMessageId];
    const transcriptElement = contentRef.current;
    if (!targetElement || !transcriptElement) {
      return () => {
        cancelled = true;
        clearScheduledScroll();
      };
    }

    const handleLayoutChange = () => {
      if (cancelled) return;
      scheduleScroll("auto");
      scheduleSettleCheck();
    };

    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(handleLayoutChange);
      resizeObserver.observe(transcriptElement);
      resizeObserver.observe(targetElement);
    }

    if (typeof MutationObserver !== "undefined") {
      mutationObserver = new MutationObserver(handleLayoutChange);
      mutationObserver.observe(transcriptElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }

    if (!resizeObserver && !mutationObserver) {
      return () => {
        cancelled = true;
        clearScheduledScroll();
      };
    }

    scheduleSettleCheck();
    maxObserveTimer = window.setTimeout(() => {
      maxObserveTimer = null;
      scheduleScroll("auto");
      finishObserving();
    }, TRANSCRIPT_SCROLL_MAX_OBSERVE_MS);

    return () => {
      cancelled = true;
      disconnectObservers();
      clearScheduledScroll();
    };
  }, [focusMessageId, messages, navigationKey, viewportRef]);

  return (
    <div
      ref={(node) => {
        contentRef.current = node;
        assignRef(transcriptRef, node);
      }}
      className={cn("min-w-0", contentClassName)}
    >
      {messages.map((message) => {
        const isFocused = message.id === focusMessageId;
        const isHighlighted = highlightedMessageIdSet.has(message.id);
        const wrapperProps =
          getMessageWrapperProps?.({
            message,
            isFocused,
            isHighlighted,
          }) ?? {};
        const { className, ...restWrapperProps } = wrapperProps;
        const claudeFooterMode =
          resolvedLoadingIndicatorVariant === "claude-mark" &&
          message.role === "assistant" &&
          message.id === lastRenderableMessageId
            ? isLoading
              ? "animated"
              : "static"
            : "none";

        return (
          <div
            key={message.id}
            ref={(element) => {
              messageRefs.current[message.id] = element;
            }}
            data-message-id={message.id}
            data-focused={isFocused ? "true" : undefined}
            data-highlighted={isHighlighted ? "true" : undefined}
            data-guided={isFocused ? "true" : undefined}
            className={cn(
              (isFocused || isHighlighted) &&
                "relative rounded-xl border border-primary/30 bg-primary/5 p-2",
              className,
            )}
            style={
              shouldUseContentVisibility && !isFocused && !isHighlighted
                ? TRANSCRIPT_MESSAGE_VISIBILITY_STYLE
                : undefined
            }
            {...restWrapperProps}
          >
            {isFocused ? (
              <motion.div
                key={String(navigationKey ?? "focus")}
                aria-hidden
                data-testid="transcript-focus-guide"
                className="pointer-events-none absolute inset-0 rounded-[inherit] ring-2 ring-primary/25"
                initial={
                  shouldReduceMotion
                    ? { opacity: 0.22, scale: 1 }
                    : { opacity: 0, scale: 0.985, y: 8 }
                }
                animate={
                  shouldReduceMotion
                    ? { opacity: 0.22, scale: 1, y: 0 }
                    : {
                        opacity: [0, 0.42, 0.14],
                        scale: [0.985, 1.01, 1],
                        y: [8, -2, 0],
                      }
                }
                transition={
                  shouldReduceMotion
                    ? { duration: 0 }
                    : { duration: 0.65, ease: [0.16, 1, 0.3, 1] }
                }
              />
            ) : null}
            <MessageView
              message={message}
              model={model}
              onSendFollowUp={sendFollowUpMessage}
              toolsMetadata={toolsMetadata}
              toolServerMap={toolServerMap}
              onWidgetStateChange={onWidgetStateChange}
              onModelContextUpdate={onModelContextUpdate}
              pipWidgetId={pipWidgetId}
              fullscreenWidgetId={fullscreenWidgetId}
              onRequestPip={onRequestPip}
              onExitPip={onExitPip}
              onRequestFullscreen={onRequestFullscreen}
              onExitFullscreen={onExitFullscreen}
              displayMode={displayMode}
              onDisplayModeChange={onDisplayModeChange}
              selectedProtocolOverrideIfBothExists={
                selectedProtocolOverrideIfBothExists
              }
              onToolApprovalResponse={onToolApprovalResponse}
              toolRenderOverrides={toolRenderOverrides}
              showSaveViewButton={showSaveViewButton}
              minimalMode={minimalMode}
              interactive={interactive}
              reasoningDisplayMode={reasoningDisplayMode}
              claudeFooterMode={claudeFooterMode}
            />
          </div>
        );
      })}
    </div>
  );
}
