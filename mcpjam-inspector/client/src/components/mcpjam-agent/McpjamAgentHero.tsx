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
} from "react";
import { MessageSquareText } from "lucide-react";
import { usePostHog } from "posthog-js/react";
import { generateId } from "ai";
import { cn } from "@/lib/utils";
import { McpjamAgentComposer } from "@/components/mcpjam-agent/McpjamAgentComposer";
import {
  appendRecentMcpjamAgentSession,
  loadRecentMcpjamAgentSessions,
  subscribeMcpjamAgentSessions,
  type RecentMcpjamAgentSession,
} from "@/components/mcpjam-agent/recent-sessions";

const DEFAULT_SUGGESTED_PROMPTS: ReadonlyArray<string> = [
  "How do I run an eval?",
  "What is progressive tool discovery?",
  "What is cross host testing?",
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
  /**
   * When `false`, the submit affordances (Send button, Enter key) are
   * disabled. Suggested-prompt chips still fill the input — only the
   * actual submit is gated. Use this while project/model resolution is
   * in flight to prevent the backend from receiving an empty `model`
   * or `projectId`.
   */
  ready?: boolean;
  className?: string;
}

export function McpjamAgentHero({
  surface,
  onSessionStart,
  onResumeSession,
  suggestedPrompts = DEFAULT_SUGGESTED_PROMPTS,
  ready = true,
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

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => {
      textareaRef.current?.focus();
    }, 120);
    return () => window.clearTimeout(timer);
  }, [ready]);

  const latestRecent = useMemo<RecentMcpjamAgentSession | undefined>(
    () => recentSessions[0],
    [recentSessions]
  );

  const handleSubmit = useCallback(
    (text: string, source: "input" | "suggestion") => {
      const trimmed = text.trim();
      if (!trimmed) return;
      // Block submit while project/model resolution is in flight — the
      // backend route requires both fields, and Enter/click would otherwise
      // race ahead of the cold-load hydration.
      if (!ready) return;
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
    [onSessionStart, posthog, ready, surface]
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

  const recentHeader =
    latestRecent && onResumeSession ? (
      <button
        type="button"
        onClick={onRecentClick}
        className="group flex w-full cursor-pointer items-center gap-1.5 border-b border-border/60 px-4 py-2 text-[11px] text-muted-foreground transition hover:bg-muted/30 hover:text-foreground"
      >
        <MessageSquareText className="size-3 shrink-0" aria-hidden />
        <span className="font-medium uppercase tracking-[0.06em]">
          Recent chat
        </span>
        <span className="text-muted-foreground/50">·</span>
        <span className="min-w-0 truncate text-foreground/70 group-hover:text-foreground">
          {latestRecent.title}
        </span>
      </button>
    ) : null;

  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      <McpjamAgentComposer
        value={value}
        onChange={setValue}
        onSubmit={() => handleSubmit(value, "input")}
        ready={ready}
        loadingMessage="Loading project…"
        placeholder="Ask anything…"
        textareaRef={textareaRef}
        header={recentHeader}
      />

      <div className="flex flex-wrap gap-2">
        {suggestedPrompts.map((prompt) => (
          <button
            key={prompt}
            type="button"
            onClick={() => onSuggestedClick(prompt)}
            className="rounded-full border border-border/60 bg-muted/10 px-3 py-1 text-xs text-muted-foreground transition hover:border-border hover:bg-muted/20 hover:text-foreground"
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}
