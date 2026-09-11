import {
  setDescribeNeedsResume,
  useDescribeFlow,
} from "@/lib/mcpjam-agent/describe-flow";
import { getOrCreateAgentChat } from "@/lib/mcpjam-agent/agent-chat-instances";
import { dismissAskUserQuestions } from "@/lib/webmcp/ask-user-store";
/**
 * MCPJam Agent right-side panel.
 *
 * Mounted as a sibling of `<SidebarInset>` inside `<SidebarProvider>` so the
 * panel sits outside the router `<Outlet>` and survives navigation — a chat
 * started on Playground stays open and streaming when the user jumps to
 * Evaluate. The panel is kept mounted regardless of `isOpen` (just visually
 * hidden when closed) so closing the panel never tears down an in-flight
 * stream.
 *
 * On narrow viewports it overlays the right edge of the workspace with a
 * responsive width. The same chat stays mounted across breakpoints.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ArrowLeft, Plus, X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import {
  useEvalAgentScopes,
  newEvalChat,
  invalidateEvalTurn,
} from "@/lib/mcpjam-agent/eval-scope";
import { McpjamAgentHero } from "@/components/mcpjam-agent/McpjamAgentHero";
import { McpjamAgentThread } from "@/components/mcpjam-agent/McpjamAgentThread";
import {
  agentPanelWidthBounds,
  clampAgentPanelWidth,
  useAgentPanelStore,
} from "@/stores/agent-panel/agent-panel-store";
import { track } from "@/lib/analytics";
import { writePendingAgentPrompt } from "@/lib/mcpjam-agent/pending-prompt";

interface AgentSidePanelProps {
  projectId: string | null;
  organizationId: string | null;
  /** Current top-level route tab name, used for telemetry payloads. */
  activeTab: string;
}

const SURFACE = "side-panel";

export function AgentSidePanel({
  projectId,
  organizationId,
  activeTab,
}: AgentSidePanelProps) {
  const [overlay, setOverlay] = useState(
    () => window.matchMedia("(max-width: 1023px)").matches,
  );
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1023px)");
    const update = () => {
      setOverlay(media.matches);
      setViewportWidth(window.innerWidth);
    };
    update();
    media.addEventListener("change", update);
    window.addEventListener("resize", update);
    return () => {
      media.removeEventListener("change", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  const isOpen = useAgentPanelStore((s) => s.isOpen);
  const width = useAgentPanelStore((s) => s.width);
  const storedSessionId = useAgentPanelStore((s) => s.activeSessionId);
  const storedSessionProjectId = useAgentPanelStore(
    (s) => s.activeSessionProjectId,
  );
  const setOpen = useAgentPanelStore((s) => s.setOpen);
  const setWidth = useAgentPanelStore((s) => s.setWidth);
  const setActiveSession = useAgentPanelStore((s) => s.setActiveSession);

  // Only honor the persisted session pointer when it was stored under the
  // currently active project. Cross-tab sync or a fresh reload landing on a
  // different project would otherwise hydrate a transcript from project A
  // into a panel currently scoped to project B.
  const activeSessionId =
    storedSessionId && storedSessionProjectId === projectId
      ? storedSessionId
      : null;

  const evalScope = useEvalAgentScopes((s) =>
    activeSessionId ? s.scopes[activeSessionId] : undefined,
  );

  // Track previous open state to fire close telemetry exactly when the user
  // closes the panel — not on every render where `isOpen` happens to be false.
  const previousOpenRef = useRef(isOpen);
  useEffect(() => {
    if (previousOpenRef.current && !isOpen) {
      if (activeSessionId && evalScope) {
        const chat = getOrCreateAgentChat(activeSessionId).chat;
        if (
          (chat.status === "submitted" || chat.status === "streaming") &&
          useDescribeFlow.getState().sessions[activeSessionId]?.phase ===
            "describing"
        ) {
          setDescribeNeedsResume(activeSessionId, true);
          invalidateEvalTurn(activeSessionId);
        }
      }
      track("mcpjam_agent_panel_closed", {
        location: "agent_side_panel",
        tab: activeTab,
      });
    }
    previousOpenRef.current = isOpen;
  }, [activeTab, isOpen, activeSessionId, evalScope]);

  const abandonCurrentEvalTurn = useCallback(() => {
    if (!activeSessionId || !evalScope) return;
    invalidateEvalTurn(activeSessionId);
    dismissAskUserQuestions("new_message", { scope: activeSessionId });
    void getOrCreateAgentChat(activeSessionId).chat.stop();
  }, [activeSessionId, evalScope]);

  const handleNewChat = useCallback(() => {
    abandonCurrentEvalTurn();
    if (evalScope) newEvalChat(evalScope);
    else setActiveSession(null, null);
  }, [setActiveSession, evalScope, abandonCurrentEvalTurn]);

  const handleSessionStart = useCallback(
    (sessionId: string, firstMessage: string) => {
      // Stash the prompt for `McpjamAgentThread` to autosubmit on mount,
      // mirroring the home-tab hero → thread handoff. `fresh: true` flags it
      // as a freshly-minted session so the thread doesn't replay it against
      // a hydrated transcript (see `McpjamAgentThread`'s consumePending).
      writePendingAgentPrompt(sessionId, firstMessage);
      setActiveSession(sessionId, projectId);
    },
    [projectId, setActiveSession],
  );

  const handleResumeSession = useCallback(
    (sessionId: string) => {
      setActiveSession(sessionId, projectId);
    },
    [projectId, setActiveSession],
  );

  const handleClose = useCallback(() => {
    setOpen(false);
  }, [setOpen]);

  const body = useMemo<ReactNode>(() => {
    if (activeSessionId) {
      return (
        <McpjamAgentThread
          key={activeSessionId}
          sessionId={activeSessionId}
          projectId={projectId}
          organizationId={organizationId}
          surface={SURFACE}
          variant="sidebar"
          className="flex-1 min-h-0"
        />
      );
    }
    return (
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="flex w-full flex-col gap-6 px-4 pb-8 pt-6">
          <McpjamAgentHero
            surface={SURFACE}
            onSessionStart={handleSessionStart}
            onResumeSession={handleResumeSession}
            ready={Boolean(projectId)}
          />
        </div>
      </div>
    );
  }, [
    activeSessionId,
    handleResumeSession,
    handleSessionStart,
    organizationId,
    projectId,
  ]);

  const header = (
    <div className="flex items-center justify-between border-b border-border/40 px-3 py-2">
      {evalScope ? (
        <p className="px-1 text-sm font-semibold">Ask MCPJam</p>
      ) : (
        <div className="flex items-center gap-1">
          {activeSessionId && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleNewChat}
              aria-label="Back to compose"
              className="h-8 w-8 rounded-full p-0 text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleNewChat}
            className="h-8 gap-1.5 rounded-full px-3 text-muted-foreground hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            <span className="text-xs">New chat</span>
          </Button>
        </div>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleClose}
        aria-label="Close MCPJam Agent"
        className="h-8 w-8 rounded-full p-0 text-muted-foreground hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </Button>
    </div>
  );

  return (
    <InlineSidePanelShell
      isOpen={isOpen}
      overlay={overlay}
      viewportWidth={viewportWidth}
      width={clampAgentPanelWidth(width, viewportWidth)}
      onWidthChange={setWidth}
      onWidthCommit={(committed) => {
        if (committed < agentPanelWidthBounds(viewportWidth).min * 0.9) {
          setOpen(false);
        } else {
          track("mcpjam_agent_panel_resized", {
            location: "agent_side_panel",
            width: committed,
          });
        }
      }}
    >
      {header}
      {body}
    </InlineSidePanelShell>
  );
}

interface InlineSidePanelShellProps {
  isOpen: boolean;
  overlay: boolean;
  viewportWidth: number;
  width: number;
  onWidthChange: (next: number) => void;
  onWidthCommit: (committed: number) => void;
  children: ReactNode;
}

function InlineSidePanelShell({
  isOpen,
  overlay,
  viewportWidth,
  width,
  onWidthChange,
  onWidthCommit,
  children,
}: InlineSidePanelShellProps) {
  const draggingRef = useRef(false);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      draggingRef.current = true;

      const onPointerMove = (moveEvent: PointerEvent) => {
        if (!draggingRef.current) return;
        // Panel sits on the right edge; pulling left increases width.
        onWidthChange(window.innerWidth - moveEvent.clientX);
      };
      const onPointerUp = (upEvent: PointerEvent) => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        handle.releasePointerCapture(upEvent.pointerId);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        const committed = window.innerWidth - upEvent.clientX;
        onWidthCommit(committed);
      };
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    },
    [onWidthChange, onWidthCommit],
  );

  const style: CSSProperties = {
    width: `${width}px`,
    maxWidth: "calc(100% - 24px)",
    // Keep the panel mounted even when closed so an in-flight stream isn't
    // canceled by toggling the trigger. `display: none` is enough to drop it
    // out of the flex layout without unmounting `useChat`.
    display: isOpen ? undefined : "none",
  };

  return (
    <aside
      data-slot="agent-side-panel"
      data-agent-dock="side"
      aria-label="Ask MCPJam"
      className={cn(
        "flex min-h-0 shrink-0 flex-col border-l border-input bg-background",
        overlay ? "absolute inset-y-0 right-0 z-30" : "relative",
      )}
      style={style}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize MCPJam Agent panel"
        tabIndex={0}
        aria-valuemin={agentPanelWidthBounds(viewportWidth).min}
        aria-valuemax={agentPanelWidthBounds(viewportWidth).max}
        aria-valuenow={width}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          onWidthChange(width + (event.key === "ArrowLeft" ? 24 : -24));
        }}
        onPointerDown={onPointerDown}
        className={cn(
          "absolute z-10 touch-none bg-transparent transition hover:bg-input/70 active:bg-input focus-visible:outline-ring",
          "inset-y-0 left-0 w-1.5 -translate-x-1/2 cursor-col-resize",
        )}
      />
      {children}
    </aside>
  );
}
