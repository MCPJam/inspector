/**
 * McpjamAgentThread — full conversation surface for the MCPJam Agent.
 *
 * Wraps `useMcpjamAgentSession` and mounts the chat-v2 `Thread` (the same
 * wrapper `ChatTabV2` uses) inside a `<StickToBottom>` viewport, so the
 * agent inherits autoscroll-while-streaming, the scroll-to-bottom button,
 * the standalone thinking indicator, MCP Apps widget surfaces, and the
 * fullscreen chat overlay infrastructure without reimplementing any of it.
 *
 * `minimalMode` strips the inspector/debugging affordances (save-as-test-case,
 * save-view, prompts popover, attachments toolbar, etc.) — appropriate for
 * this conversational helper surface.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { StickToBottom } from "use-stick-to-bottom";
import { cn } from "@/lib/utils";
import { McpjamAgentComposer } from "@/components/mcpjam-agent/McpjamAgentComposer";
import { Thread } from "@/components/chat-v2/thread";
import { MarkdownLinkBaseProvider } from "@/components/chat-v2/thread/memomized-markdown";
import { ScrollToBottomButton } from "@/components/chat-v2/shared/scroll-to-bottom-button";
import { LoadingIndicatorContent } from "@/components/chat-v2/shared/loading-indicator-content";
import { UserMessageBubble } from "@/components/chat-v2/thread/user-message-bubble";
import {
  ChatboxHostStyleProvider,
  ChatboxHostThemeProvider,
} from "@/contexts/chatbox-client-style-context";
import { getChatboxShellStyle } from "@/lib/chatbox-client-style";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { useMcpjamAgentSession } from "@/hooks/use-mcpjam-agent-session";
import {
  appendRecentMcpjamAgentSession,
  loadRecentMcpjamAgentSessions,
} from "@/components/mcpjam-agent/recent-sessions";

export interface McpjamAgentThreadProps {
  sessionId: string;
  /** Required so the agent can persist the chat to the user's project. */
  projectId: string | null;
  organizationId: string | null;
  /** Telemetry surface. */
  surface: string;
  /**
   * Visual mode. `"card"` (default) is the embedded rounded card used inside
   * a wider page. `"full"` is the PostHog/Attio-style takeover: no border,
   * fills the parent, composer pinned to the bottom. `"sidebar"` is the
   * right-side panel surface: fills the parent like `"full"` but without
   * the centered max-width column — the panel itself is already narrow.
   */
  variant?: "card" | "full" | "sidebar";
  className?: string;
}

export function McpjamAgentThread({
  sessionId,
  projectId,
  organizationId,
  surface,
  variant = "card",
  className,
}: McpjamAgentThreadProps) {
  const session = useMcpjamAgentSession({
    chatSessionId: sessionId,
    projectId,
    organizationId,
    surface,
  });

  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Peek at the hero-stashed pending prompt at mount so we can render an
  // optimistic user bubble during the hydrate → autosubmit window. Without
  // this, the user sees the brand mark centered on an empty surface and
  // wonders if their submit landed. We only PEEK here (read, don't remove)
  // — the autosubmit effect below is still the authoritative consumer that
  // also writes the `mcpjam:agent-pending` key, so removing it twice would
  // race the autosubmit.
  const [optimisticPending] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.sessionStorage.getItem(
        `mcpjam:agent-pending:${sessionId}`
      );
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed as { fresh?: unknown }).fresh === true &&
        typeof (parsed as { text?: unknown }).text === "string"
      ) {
        return (parsed as { text: string }).text;
      }
      return null;
    } catch {
      return null;
    }
  });

  const isStreaming =
    session.status === "submitted" || session.status === "streaming";

  // Both the backend route and the persistence path require a resolved
  // model + projectId. On cold load either can be undefined for a few
  // frames; gate every submit affordance on both being present.
  const isReady = session.model != null && projectId != null;

  const handleSubmit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (!isReady) return;
      session.submit(trimmed);
      setDraft("");
      const existing = loadRecentMcpjamAgentSessions().find(
        (s) => s.id === sessionId
      );
      const title =
        trimmed.length > 50 ? `${trimmed.slice(0, 50)}…` : trimmed;
      appendRecentMcpjamAgentSession({
        id: sessionId,
        title: existing?.title ?? title,
        ts: Date.now(),
      });
    },
    [isReady, session, sessionId]
  );

  useEffect(() => {
    if (session.hydrating) return;
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, [session.hydrating, sessionId]);

  // Consume a hero-stashed pending prompt exactly once per session id —
  // the hero captured the user's first message before swapping us in via
  // the URL param. Without this, the prompt would be lost in the swap.
  //
  // The stored value is `{ text, fresh: true }` JSON written by the hero's
  // mint path. Resume from the Recent Chat pill never writes a pending
  // value at all, so `fresh` is the only authoritative "this is a brand
  // new session id" signal — we used to rely on `messages.length === 0`,
  // but `setMessages(initialMessages)` from hydration may not have
  // committed yet on the first effect pass, so an already-hydrated
  // session could see length 0 for one frame and replay the prompt. The
  // `fresh` flag dodges that race entirely.
  //
  // Tolerates the legacy plain-string shape (no `fresh` field) by
  // refusing to autosubmit it — better to lose one in-flight prompt than
  // replay against a hydrated transcript.
  const consumedPendingRef = useRef<string | null>(null);
  useEffect(() => {
    if (session.hydrating) return;
    if (!isReady) return;
    if (consumedPendingRef.current === sessionId) return;
    if (typeof window === "undefined") return;
    let raw: string | null = null;
    try {
      raw = window.sessionStorage.getItem(`mcpjam:agent-pending:${sessionId}`);
      window.sessionStorage.removeItem(`mcpjam:agent-pending:${sessionId}`);
    } catch {
      raw = null;
    }
    consumedPendingRef.current = sessionId;
    if (!raw) return;
    let pendingText = "";
    let isFresh = false;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { text?: unknown }).text === "string"
      ) {
        pendingText = (parsed as { text: string }).text;
        isFresh = (parsed as { fresh?: unknown }).fresh === true;
      }
    } catch {
      pendingText = "";
      isFresh = false;
    }
    if (isFresh && pendingText.trim()) {
      handleSubmit(pendingText);
    }
  }, [handleSubmit, isReady, session.hydrating, sessionId]);

  const isFull = variant === "full";
  const isSidebar = variant === "sidebar";
  const fillsParent = isFull || isSidebar;
  // The takeover surface centers content in a max-w-4xl column; the sidebar
  // surface is already narrow, so it fills the available width instead.
  const contentColumnClassName = isSidebar
    ? "min-w-0 w-full px-4 pt-6 pb-8 space-y-6"
    : "min-w-0 w-full max-w-4xl mx-auto px-4 pt-6 pb-8 space-y-6";
  const composerColumnClassName = isSidebar
    ? "w-full mb-4 px-3"
    : "mx-auto w-full max-w-4xl mb-6 px-4";
  const themeMode = usePreferencesStore((state) => state.themeMode);
  const shellStyle = getChatboxShellStyle("mcpjam", themeMode);

  const composer = (
    <McpjamAgentComposer
      value={draft}
      onChange={setDraft}
      onSubmit={() => handleSubmit(draft)}
      ready={isReady}
      loadingMessage="Loading project…"
      placeholder="Continue the conversation…"
      isStreaming={isStreaming}
      onStop={() => session.stop()}
      textareaRef={textareaRef}
      className={fillsParent ? composerColumnClassName : undefined}
    />
  );

  // Hydration / model-resolution placeholders — keep these in the host-style
  // shell so the brand chrome is consistent with the loaded state. We render
  // the composer below them so the user can start typing while we wait.
  // Show the optimistic bubble only when there's nothing real yet — once
  // `session.messages` has the user message the real Thread takes over and
  // the optimistic UI unmounts.
  const showOptimisticPending =
    optimisticPending != null && session.messages.length === 0;

  let body: React.ReactNode;
  if (showOptimisticPending) {
    // Hero → submit landing: render the user's pending text in the same
    // column the real chat uses, plus the brand thinking indicator below.
    // No "Loading conversation…" text — the user just wants to see their
    // message land.
    body = (
      <div className="flex flex-1 flex-col min-h-0 overflow-y-auto">
        <div className={contentColumnClassName}>
          <UserMessageBubble>
            <p className="whitespace-pre-wrap">{optimisticPending}</p>
          </UserMessageBubble>
          <div className="text-sm text-muted-foreground">
            <LoadingIndicatorContent />
          </div>
        </div>
      </div>
    );
  } else if (session.hydrating) {
    // Resumed session (no optimistic pending): the user came from the
    // Recent Chat pill or a direct URL, so brand-marker-only is fine.
    body = (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        <LoadingIndicatorContent />
      </div>
    );
  } else if (session.messages.length === 0) {
    body = (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Ask anything to start the conversation.
      </div>
    );
  } else if (!session.model) {
    body = (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Resolving model…
      </div>
    );
  } else {
    // The real chat surface: chat-v2 `Thread` (with widget hosts, fullscreen
    // overlay, standalone thinking indicator) inside a `<StickToBottom>` so
    // streaming output auto-scrolls and the scroll-to-bottom button appears
    // when the user scrolls up — matching `ChatTabV2.tsx:2483`.
    body = (
      <StickToBottom
        className="relative flex flex-1 flex-col min-h-0"
        resize="smooth"
        initial="smooth"
      >
        <div className="relative flex-1 min-h-0">
          <StickToBottom.Content className="flex flex-col min-h-0">
            <Thread
              chatSessionId={sessionId}
              messages={session.messages}
              model={session.model}
              toolsMetadata={{}}
              toolServerMap={{}}
              sendFollowUpMessage={handleSubmit}
              isLoading={isStreaming}
              minimalMode
              // Match `Thread`'s standalone-thinking-indicator wrapper
              // (`thread.tsx:368` uses `max-w-4xl mx-auto px-4`) so the dots
              // sit in the same column as the would-be assistant message
              // instead of floating ~64px to the left of it.
              contentClassName={contentColumnClassName}
            />
          </StickToBottom.Content>
          <ScrollToBottomButton />
        </div>
      </StickToBottom>
    );
  }

  return (
    <MarkdownLinkBaseProvider base="https://docs.mcpjam.com" trustLinks>
      <ChatboxHostStyleProvider value="mcpjam">
        <ChatboxHostThemeProvider value={themeMode}>
        <div
          className={cn(
            "chatbox-host-shell flex flex-col gap-4 min-h-0",
            fillsParent
              ? "h-full"
              : "min-h-[36rem] rounded-2xl border border-border/70 bg-card/30 p-4 shadow-sm",
            className
          )}
          data-host-style="mcpjam"
          style={shellStyle}
        >
          {body}
          {composer}
          {session.error && (
            <p
              className={cn(
                "text-xs text-destructive",
                isFull && "mx-auto w-full max-w-4xl px-4",
                isSidebar && "w-full px-3"
              )}
            >
              {session.error.message ?? "Something went wrong."}
            </p>
          )}
        </div>
        </ChatboxHostThemeProvider>
      </ChatboxHostStyleProvider>
    </MarkdownLinkBaseProvider>
  );
}
