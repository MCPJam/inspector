/**
 * McpjamAgentThread — full conversation surface for the MCPJam Agent.
 *
 * Wraps `useMcpjamAgentSession` and reuses the chat-v2 thread presenters
 * (`TranscriptThread`). Renders a continue-conversation input row at the
 * bottom that calls back into the hook's `submit()`.
 *
 * Verified that `TranscriptThread` accepts `UIMessage[]` directly (`messages`
 * prop) — no shared-code refactor needed.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { ArrowUp, Loader2, Square } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { TextareaAutosize } from "@/components/ui/textarea-autosize";
import { cn } from "@/lib/utils";
import { TranscriptThread } from "@/components/chat-v2/thread/transcript-thread";
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
  className?: string;
}

export function McpjamAgentThread({
  sessionId,
  projectId,
  organizationId,
  surface: _surface,
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
      // Refresh the local registry so the title reflects the most recent
      // exchange (best-effort — purely for the home-page pill).
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

  // Once hydration completes and the thread has messages, scroll the input
  // into view so the user can keep typing.
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
      // Legacy plain-string payload — refuse to autosubmit (see comment
      // above).
      pendingText = "";
      isFresh = false;
    }
    if (isFresh && pendingText.trim()) {
      handleSubmit(pendingText);
    }
  }, [handleSubmit, isReady, session.hydrating, sessionId]);

  return (
    <div
      className={cn(
        "flex min-h-[36rem] flex-col gap-4 rounded-2xl border border-border/70 bg-card/30 p-4 shadow-sm",
        className
      )}
    >
      <div className="flex-1 overflow-y-auto">
        {session.hydrating ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Loading conversation…
          </div>
        ) : session.messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Ask anything to start the conversation.
          </div>
        ) : session.model ? (
          <TranscriptThread
            chatSessionId={sessionId}
            messages={session.messages}
            model={session.model}
            toolsMetadata={{}}
            toolServerMap={{}}
            sendFollowUpMessage={handleSubmit}
            isLoading={isStreaming}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Resolving model…
          </div>
        )}
      </div>

      <form
        onSubmit={onFormSubmit}
        className="relative rounded-2xl border border-border/70 bg-card/60 p-2 shadow-sm transition focus-within:border-border focus-within:bg-card focus-within:shadow"
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

      {session.error && (
        <p className="text-xs text-destructive">
          {session.error.message ?? "Something went wrong."}
        </p>
      )}
    </div>
  );
}
