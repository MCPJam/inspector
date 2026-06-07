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
 * On viewports < 768px the panel renders as a full-width `Sheet` drawer
 * instead of an inline resizable panel.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ArrowLeft, Plus, X } from "lucide-react";
import { usePostHog } from "posthog-js/react";
import { Button } from "@mcpjam/design-system/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@mcpjam/design-system/sheet";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { McpjamAgentHero } from "@/components/mcpjam-agent/McpjamAgentHero";
import { McpjamAgentThread } from "@/components/mcpjam-agent/McpjamAgentThread";
import {
  AGENT_PANEL_MIN_WIDTH,
  useAgentPanelStore,
} from "@/stores/agent-panel/agent-panel-store";

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
  const isMobile = useIsMobile();
  const isOpen = useAgentPanelStore((s) => s.isOpen);
  const width = useAgentPanelStore((s) => s.width);
  const activeSessionId = useAgentPanelStore((s) => s.activeSessionId);
  const setOpen = useAgentPanelStore((s) => s.setOpen);
  const setWidth = useAgentPanelStore((s) => s.setWidth);
  const setActiveSessionId = useAgentPanelStore((s) => s.setActiveSessionId);
  const posthog = usePostHog();

  // Track previous open state to fire close telemetry exactly when the user
  // closes the panel — not on every render where `isOpen` happens to be false.
  const previousOpenRef = useRef(isOpen);
  useEffect(() => {
    if (previousOpenRef.current && !isOpen) {
      posthog?.capture("mcpjam_agent_panel_closed", { tab: activeTab });
    }
    previousOpenRef.current = isOpen;
  }, [activeTab, isOpen, posthog]);

  const handleNewChat = useCallback(() => {
    setActiveSessionId(null);
  }, [setActiveSessionId]);

  const handleSessionStart = useCallback(
    (sessionId: string, firstMessage: string) => {
      // Stash the prompt for `McpjamAgentThread` to autosubmit on mount,
      // mirroring the home-tab hero → thread handoff. `fresh: true` flags it
      // as a freshly-minted session so the thread doesn't replay it against
      // a hydrated transcript (see `McpjamAgentThread`'s consumePending).
      try {
        if (typeof window !== "undefined") {
          window.sessionStorage.setItem(
            `mcpjam:agent-pending:${sessionId}`,
            JSON.stringify({ text: firstMessage, fresh: true })
          );
        }
      } catch {
        // Quota/disabled storage — user will retype if it doesn't autosubmit.
      }
      setActiveSessionId(sessionId);
    },
    [setActiveSessionId]
  );

  const handleResumeSession = useCallback(
    (sessionId: string) => {
      setActiveSessionId(sessionId);
    },
    [setActiveSessionId]
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

  if (isMobile) {
    return (
      <Sheet open={isOpen} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 bg-background p-0 sm:max-w-md [&>button]:hidden"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>MCPJam Agent</SheetTitle>
            <SheetDescription>
              Ask the MCPJam Agent for help with docs, evals, and tools.
            </SheetDescription>
          </SheetHeader>
          {header}
          {body}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <InlineSidePanelShell
      isOpen={isOpen}
      width={width}
      onWidthChange={setWidth}
      onWidthCommit={(committed) => {
        if (committed < AGENT_PANEL_MIN_WIDTH * 0.9) {
          setOpen(false);
        } else {
          posthog?.capture("mcpjam_agent_panel_resized", { width: committed });
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
  width: number;
  onWidthChange: (next: number) => void;
  onWidthCommit: (committed: number) => void;
  children: ReactNode;
}

function InlineSidePanelShell({
  isOpen,
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
        const next = window.innerWidth - moveEvent.clientX;
        onWidthChange(next);
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
    [onWidthChange, onWidthCommit]
  );

  const style: CSSProperties = {
    width: `${width}px`,
    // Keep the panel mounted even when closed so an in-flight stream isn't
    // canceled by toggling the trigger. `display: none` is enough to drop it
    // out of the flex layout without unmounting `useChat`.
    display: isOpen ? undefined : "none",
  };

  return (
    <aside
      data-slot="agent-side-panel"
      className={cn(
        "relative hidden shrink-0 flex-col border-l border-border/60 bg-background md:flex"
      )}
      style={style}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize MCPJam Agent panel"
        onPointerDown={onPointerDown}
        className="absolute inset-y-0 left-0 z-10 w-1.5 -translate-x-1/2 cursor-col-resize bg-transparent transition hover:bg-border/70 active:bg-border"
      />
      {children}
    </aside>
  );
}
