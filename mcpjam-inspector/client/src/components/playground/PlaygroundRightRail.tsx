import { useCallback, useState } from "react";
import {
  FileText,
  Loader2,
  PanelRightClose,
  TerminalSquare,
} from "lucide-react";
import { usePostHog } from "posthog-js/react";
import { Button } from "@mcpjam/design-system/button";
import { standardEventProps } from "@/lib/PosthogUtils";
import { cn } from "@/lib/utils";
import { LoggerView } from "@/components/logger-view";
import { ComputerStatusChip } from "@/components/computer/ComputerStatusChip";
import { ComputerTerminalPane } from "@/components/computer/ComputerTerminalPane";
import { useComputerTerminal } from "@/components/computer/useComputerTerminal";
import { useComputersEnabledState } from "@/hooks/useComputersEnabled";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";

/**
 * Playground right rail. Single-purpose log viewer by default; when the
 * previewed host has a Project Computer attached (and computers are enabled),
 * it becomes a Logs | Shell tabbed panel so you can drop into a live terminal
 * on the same box the harness runs on. Mirrors `PlaygroundLeftRail`'s tab
 * pattern; rail visibility/collapse is owned by `PlaygroundTab`.
 */
export function PlaygroundRightRail({
  onClose,
  hostConfig,
  projectId,
  isAuthenticated,
}: {
  onClose: () => void;
  hostConfig: HostConfigDtoV2 | null;
  projectId: string | null;
  isAuthenticated: boolean;
}) {
  const computersEnabled = useComputersEnabledState();
  const shellAvailable = computersEnabled === true && !!hostConfig?.computer;

  if (!shellAvailable) {
    return <LoggerView onClose={onClose} />;
  }
  return (
    <RightRailTabbed
      onClose={onClose}
      projectId={projectId}
      isAuthenticated={isAuthenticated}
    />
  );
}

type RightRailTab = "logs" | "shell";

function RightRailTabbed({
  onClose,
  projectId,
  isAuthenticated,
}: {
  onClose: () => void;
  projectId: string | null;
  isAuthenticated: boolean;
}) {
  const [activeTab, setActiveTab] = useState<RightRailTab>("logs");
  const posthog = usePostHog();
  // One controller for the rail so the terminal session survives Logs ⇄ Shell
  // toggles (both bodies stay mounted; we only show/hide).
  const ct = useComputerTerminal({ projectId, isAuthenticated });
  // The Shell opens in the computer's default directory. Opening it in the
  // harness session workdir (cd into the agent's cwd) is a FOLLOW-UP: it needs
  // both a producer (the chat stream emitting `sessionWorkDir`) and cwd
  // threading through the terminal WebSocket, neither of which is in this
  // restore (they depend on the harness-session/create-pty changes that
  // conflict with main's newer commits).

  const handleTabClick = useCallback(
    (next: RightRailTab) => {
      if (next === activeTab) return;
      posthog?.capture("playground_right_rail_tab_changed", {
        ...standardEventProps("playground_right_rail"),
        from: activeTab,
        to: next,
      });
      setActiveTab(next);
    },
    [activeTab, posthog],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-0.5 border-b border-border px-2 py-1">
        <TabButton
          icon={FileText}
          label="Logs"
          isActive={activeTab === "logs"}
          onClick={() => handleTabClick("logs")}
        />
        <TabButton
          icon={TerminalSquare}
          label="Shell"
          isActive={activeTab === "shell"}
          onClick={() => handleTabClick("shell")}
        />
        <button
          type="button"
          onClick={onClose}
          aria-label="Collapse panel"
          className="ml-auto rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <PanelRightClose className="h-3.5 w-3.5" />
        </button>
      </div>
      {/* Keep BOTH bodies mounted — toggling tabs must not drop the live
          terminal WebSocket or the log stream. */}
      <div
        className={cn(
          "min-h-0 flex-1",
          activeTab === "logs" ? "flex flex-col" : "hidden",
        )}
      >
        <LoggerView isCollapsable={false} />
      </div>
      <div
        className={cn(
          "min-h-0 flex-1 flex-col",
          activeTab === "shell" ? "flex" : "hidden",
        )}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
          <ComputerStatusChip status={ct.liveStatus} />
          {!ct.terminalOpen && !ct.dataPlaneUnavailable ? (
            <Button
              size="sm"
              onClick={() => void ct.openTerminal()}
              disabled={ct.starting}
            >
              {ct.starting ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <TerminalSquare className="mr-1.5 h-3.5 w-3.5" />
              )}
              Open terminal
            </Button>
          ) : null}
        </div>
        <ComputerTerminalPane controller={ct} className="px-3 pb-3" />
      </div>
    </div>
  );
}

function TabButton({
  icon: Icon,
  label,
  isActive,
  onClick,
}: {
  icon: typeof FileText;
  label: string;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors",
        isActive
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
      aria-pressed={isActive}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}
