import { useCallback, useState } from "react";
import {
  FileText,
  FolderTree,
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
import { useHarnessWorkdir } from "@/stores/harness-workdir-store";
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
  hostId,
  projectId,
  isAuthenticated,
}: {
  onClose: () => void;
  hostConfig: HostConfigDtoV2 | null;
  /** Convex host document id (previewedHostId) — the SAME id the chat stream
   *  keys the harness workdir cache by. NOT hostConfig.id (a content-addressed
   *  config id), which would never match the write side. */
  hostId: string | null;
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
      hostConfig={hostConfig}
      hostId={hostId}
    />
  );
}

type RightRailTab = "logs" | "shell";

function RightRailTabbed({
  onClose,
  projectId,
  isAuthenticated,
  hostConfig,
  hostId,
}: {
  onClose: () => void;
  projectId: string | null;
  isAuthenticated: boolean;
  hostConfig: HostConfigDtoV2 | null;
  hostId: string | null;
}) {
  const [activeTab, setActiveTab] = useState<RightRailTab>("logs");
  // Bumped to remount (and thus reconnect) the terminal into the latest harness
  // workdir on demand — cwd only applies at connect time.
  const [reloadKey, setReloadKey] = useState(0);
  const posthog = usePostHog();
  // One controller for the rail so the terminal session survives Logs ⇄ Shell
  // toggles (both bodies stay mounted; we only show/hide).
  const ct = useComputerTerminal({ projectId, isAuthenticated });
  // Open the terminal in the harness session workdir — but only for harness
  // hosts (plain computer hosts have no such dir → home).
  const isHarnessHost = hostConfig?.harness === "claude-code";
  // Read with the SAME key the chat stream writes (previewedHostId), not
  // hostConfig.id — those are different identifiers and would never match.
  const streamedWorkdir = useHarnessWorkdir(projectId, hostId);
  const harnessCwd = isHarnessHost ? streamedWorkdir : undefined;

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
          ) : ct.terminalOpen && harnessCwd ? (
            // cwd is applied at connect time; remount to reconnect into the
            // latest harness workdir (e.g. after a new turn ran).
            <Button
              size="sm"
              variant="outline"
              onClick={() => setReloadKey((k) => k + 1)}
              title={`Reconnect in ${harnessCwd}`}
            >
              <FolderTree className="mr-1.5 h-3.5 w-3.5" />
              Reload in harness dir
            </Button>
          ) : null}
        </div>
        {/* Key on reloadKey ONLY (explicit reconnect) — NOT on cwd, so a newer
            harness workdir streaming in mid-session doesn't yank the user's open
            terminal. Reopening the terminal already picks up the latest cwd
            (ComputerTerminal remounts when terminalOpen flips). */}
        <ComputerTerminalPane
          key={reloadKey}
          controller={ct}
          className="px-3 pb-3"
          {...(harnessCwd ? { cwd: harnessCwd } : {})}
        />
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
