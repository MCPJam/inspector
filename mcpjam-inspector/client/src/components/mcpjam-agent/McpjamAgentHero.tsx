/**
 * McpjamAgentHero — "Ask anything…" composer for the MCPJam Agent surfaces.
 *
 * Renders a centered greeting-adjacent input plus suggested-prompt chips and
 * an optional "Recent chat" pill driven by a small localStorage registry.
 *
 * The hero does NOT own routing — the consumer supplies `onSessionStart` and
 * `onResumeSession` so different surfaces (home page URL param vs. future
 * bubble overlay) can transition however they like.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { ArrowUp, MessageSquareText } from "lucide-react";
import { usePostHog } from "posthog-js/react";
import { generateId } from "ai";
import { Button } from "@mcpjam/design-system/button";
import { TextareaAutosize } from "@/components/ui/textarea-autosize";
import { cn } from "@/lib/utils";
import {
  appendRecentMcpjamAgentSession,
  loadRecentMcpjamAgentSessions,
  subscribeMcpjamAgentSessions,
  type RecentMcpjamAgentSession,
} from "@/components/mcpjam-agent/recent-sessions";

const DEFAULT_SUGGESTED_PROMPTS: ReadonlyArray<string> = [
  "How do I run an eval?",
  "What is progressive tool discovery?",
];

export interface McpjamAgentHeroProps {
  /** Telemetry surface — "home" for HomeTab, "bubble" for the future drop-in. */
  surface: string;
  /**
   * Called on submit with the freshly-minted session id and the first
   * message text. The consumer is responsible for transitioning to the
   * thread view (URL push, overlay open, etc.).
   */
  onSessionStart: (sessionId: string, firstMessage: string) => void;
  /** Optional resume hook — invoked when the user clicks the recent pill. */
  onResumeSession?: (sessionId: string) => void;
  /** Override the hardcoded suggestion chips. */
  suggestedPrompts?: ReadonlyArray<string>;
  className?: string;
}

export function McpjamAgentHero({
  surface,
  onSessionStart,
  onResumeSession,
  suggestedPrompts = DEFAULT_SUGGESTED_PROMPTS,
  className,
}: McpjamAgentHeroProps) {
  const posthog = usePostHog();
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const [recentSessions, setRecentSessions] = useState<
    RecentMcpjamAgentSession[]
  >(() => loadRecentMcpjamAgentSessions());

  useEffect(() => {
    return subscribeMcpjamAgentSessions(setRecentSessions);
  }, []);

  const latestRecent = useMemo<RecentMcpjamAgentSession | undefined>(
    () => recentSessions[0],
    [recentSessions]
  );

  const handleSubmit = useCallback(
    (text: string, source: "input" | "suggestion") => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const sessionId = generateId();
      const title = trimmed.length > 50 ? `${trimmed.slice(0, 50)}…` : trimmed;
      appendRecentMcpjamAgentSession({
        id: sessionId,
        title,
        ts: Date.now(),
      });
      posthog?.capture("mcpjam_agent_submit", {
        surface,
        source,
        prompt_length: trimmed.length,
      });
      setValue("");
      onSessionStart(sessionId, trimmed);
    },
    [onSessionStart, posthog, surface]
  );

  const onFormSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      handleSubmit(value, "input");
    },
    [handleSubmit, value]
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter submits, Shift+Enter inserts a newline — matches chat-input.
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        handleSubmit(value, "input");
      }
    },
    [handleSubmit, value]
  );

  const onSuggestedClick = useCallback(
    (prompt: string) => {
      posthog?.capture("mcpjam_agent_suggested_prompt", {
        surface,
        prompt,
      });
      setValue(prompt);
      // Focus so the user can edit before pressing Enter — matches Attio.
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    },
    [posthog, surface]
  );

  const onRecentClick = useCallback(() => {
    if (!latestRecent || !onResumeSession) return;
    posthog?.capture("mcpjam_agent_resume", {
      surface,
      session_id: latestRecent.id,
    });
    onResumeSession(latestRecent.id);
  }, [latestRecent, onResumeSession, posthog, surface]);

  const canSubmit = value.trim().length > 0;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {latestRecent && onResumeSession && (
        <button
          type="button"
          onClick={onRecentClick}
          className="group inline-flex w-fit items-center gap-2 rounded-full border border-border/60 bg-muted/40 px-3 py-1 text-xs text-muted-foreground transition hover:border-border hover:bg-muted/70 hover:text-foreground"
        >
          <MessageSquareText className="h-3.5 w-3.5" aria-hidden />
          <span className="font-medium uppercase tracking-[0.08em] text-muted-foreground/80">
            Recent chat
          </span>
          <span className="text-muted-foreground/60">·</span>
          <span className="truncate max-w-[24rem] text-foreground/80 group-hover:text-foreground">
            {latestRecent.title}
          </span>
        </button>
      )}

      <form
        onSubmit={onFormSubmit}
        className="relative rounded-2xl border border-border/70 bg-card/60 p-2 shadow-sm transition focus-within:border-border focus-within:bg-card focus-within:shadow"
      >
        <TextareaAutosize
          ref={textareaRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask anything…"
          minRows={2}
          maxRows={10}
          className="min-h-[3.25rem] resize-none border-0 bg-transparent px-3 py-2 text-[15px] shadow-none outline-none focus-visible:border-0 focus-visible:ring-0"
        />
        <div className="flex items-center justify-end gap-2 px-1 pt-1">
          <Button
            type="submit"
            size="sm"
            disabled={!canSubmit}
            className="h-8 gap-1.5 rounded-full px-3"
          >
            <ArrowUp className="h-3.5 w-3.5" aria-hidden />
            <span>Send</span>
          </Button>
        </div>
      </form>

      <div className="flex flex-wrap gap-2">
        {suggestedPrompts.map((prompt) => (
          <button
            key={prompt}
            type="button"
            onClick={() => onSuggestedClick(prompt)}
            className="rounded-full border border-border/60 bg-card/40 px-3 py-1.5 text-xs text-muted-foreground transition hover:border-border hover:bg-card hover:text-foreground"
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}
