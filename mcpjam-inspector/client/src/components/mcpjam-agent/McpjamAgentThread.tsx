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
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { ArrowUp, Square } from "lucide-react";
import { StickToBottom } from "use-stick-to-bottom";
import { Button } from "@mcpjam/design-system/button";
import { TextareaAutosize } from "@/components/ui/textarea-autosize";
import { cn } from "@/lib/utils";
import { Thread } from "@/components/chat-v2/thread";
import { ScrollToBottomButton } from "@/components/chat-v2/shared/scroll-to-bottom-button";
import { LoadingIndicatorContent } from "@/components/chat-v2/shared/loading-indicator-content";
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
   * fills the parent, composer pinned to the bottom.
   */
  variant?: "card" | "full";
  className?: string;
}

export function McpjamAgentThread({
  sessionId,
  projectId,
  organizationId,
  surface: _surface,
  variant = "card",
  className,
}: McpjamAgentThreadProps) {
  const session = useMcpjamAgentSession({
    chatSessionId: sessionId,
    projectId,
    organizationId,
  });

  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

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

  const onFormSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      handleSubmit(draft);
    },
    [draft, handleSubmit]
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.nativeEvent.isComposing
      ) {
        event.preventDefault();
        handleSubmit(draft);
      }
    },
    [draft, handleSubmit]
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
  const themeMode = usePreferencesStore((state) => state.themeMode);
  const shellStyle = getChatboxShellStyle("mcpjam", themeMode);

  const composer = (
    <form
      onSubmit={onFormSubmit}
      className={cn(
        "relative rounded-2xl border border-border/70 bg-card/60 p-2 shadow-sm transition focus-within:border-border focus-within:bg-card focus-within:shadow",
        isFull && "mx-auto w-full max-w-3xl mb-6 px-2"
      )}
    >
      <TextareaAutosize
        ref={textareaRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={isReady ? "Continue the conversation…" : "Loading…"}
        minRows={2}
        maxRows={8}
        className="min-h-[3rem] resize-none border-0 bg-transparent px-3 py-2 text-[15px] shadow-none outline-none focus-visible:border-0 focus-visible:ring-0"
      />
      <div className="flex items-center justify-end gap-2 px-1 pt-1">
        {isStreaming ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => session.stop()}
            className="h-8 gap-1.5 rounded-full px-3"
          >
            <Square className="h-3.5 w-3.5" aria-hidden />
            <span>Stop</span>
          </Button>
        ) : (
          <Button
            type="submit"
            size="sm"
            disabled={draft.trim().length === 0 || !isReady}
            title={isReady ? undefined : "Loading project and model…"}
            className="h-8 gap-1.5 rounded-full px-3"
          >
            <ArrowUp className="h-3.5 w-3.5" aria-hidden />
            <span>Send</span>
          </Button>
        )}
      </div>
    </form>
  );

  // Hydration / model-resolution placeholders — keep these in the host-style
  // shell so the brand chrome is consistent with the loaded state. We render
  // the composer below them so the user can start typing while we wait.
  let body: React.ReactNode;
  if (session.hydrating) {
    body = (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <LoadingIndicatorContent />
        <span>Loading conversation…</span>
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
              contentClassName={cn(
                "min-w-0 w-full mx-auto px-4 pt-6 pb-8 space-y-6",
                isFull ? "max-w-3xl" : "max-w-3xl"
              )}
            />
          </StickToBottom.Content>
          <ScrollToBottomButton />
        </div>
      </StickToBottom>
    );
  }

  return (
    <ChatboxHostStyleProvider value="mcpjam">
      <ChatboxHostThemeProvider value={themeMode}>
        <div
          className={cn(
            "chatbox-host-shell flex flex-col gap-4 min-h-0",
            isFull
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
                isFull && "mx-auto w-full max-w-3xl px-2"
              )}
            >
              {session.error.message ?? "Something went wrong."}
            </p>
          )}
        </div>
      </ChatboxHostThemeProvider>
    </ChatboxHostStyleProvider>
  );
}
