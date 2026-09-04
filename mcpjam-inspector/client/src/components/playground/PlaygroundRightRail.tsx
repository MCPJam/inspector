import { useCallback, useEffect, useRef, useState } from "react";
import {
  Cloud,
  FileText,
  FolderTree,
  Globe,
  Laptop,
  Loader2,
  PanelRightClose,
  TerminalSquare,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { LoggerView } from "@/components/logger-view";
import { ComputerStatusChip } from "@/components/computer/ComputerStatusChip";
import { ComputerTerminal } from "@/components/computer/ComputerTerminal";
import { ComputerTerminalPane } from "@/components/computer/ComputerTerminalPane";
import { PaneMessage } from "@/components/computer/PaneMessage";
import { useComputerTerminal } from "@/components/computer/useComputerTerminal";
import { useComputersEnabledState } from "@/hooks/useComputersEnabled";
import {
  useComputerEngine,
  type ComputerEngineState,
} from "@/hooks/useComputerEngine";
import { useHarnessWorkdir } from "@/stores/harness-workdir-store";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { mintLocalTerminalNonce } from "@/lib/local-computer-consent";
import { LOCAL_TERMINAL_WS_PATH } from "@/lib/computer-terminal-connection";
import { LocalBrowserBody } from "@/components/browser/LocalBrowserBody";
import { HostedBrowserBody } from "@/components/browser/HostedBrowserBody";
import { useMintBrowserToken } from "@/hooks/useProjectComputer";
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

type RightRailTab = "logs" | "shell" | "browser";

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
  // Which engine serves this project's computer work. The rail is an INDICATOR
  // only — switching lives on the Computer tab, which owns the consent gate.
  //
  // NOTE: `projectId` here is `sharedProjectId ?? activeProjectId`, while
  // PlaygroundMain's engine reads `sharedProjectId` only. The divergence is
  // harmless (the engine hooks no-op without a shared project) and deliberate.
  const engine = useComputerEngine(projectId);
  // The BODY follows `selectedEngine` (consent-blind), mirroring the Computer
  // tab's face choice: someone who picked "This machine" but hasn't authorized
  // it yet must see the local body's pointer, not a cloud terminal they didn't
  // ask for. The CHIP follows the resolved `engine`, so it can never claim
  // "This machine" while commands actually run in the cloud.
  const isLocalShell = engine.selectedEngine === "local";
  // The Browser tab follows the HOST's attached capability, and ONLY that: a
  // host without `browser` has no browser for the model to drive, so a pane for
  // one would be showing something nothing can use. The engine decides which
  // BODY goes in it, not whether the tab exists — both engines have a browser,
  // and the tab vanishing on an engine switch was a rail that looked broken.
  // The hosted body additionally needs a signed-in user: every one of its
  // calls carries a minted browser token, so before authentication is ready it
  // can only fail — and it would fail into an "unreachable" state with nothing
  // to retry it once auth arrives. The Shell's cloud body gates the same way.
  const hasBrowser = Boolean(
    hostConfig?.builtInToolIds?.includes("browser") &&
    (engine.selectedEngine === "local" || isAuthenticated),
  );
  // Which body. Follows `selectedEngine` like the Shell above, so someone who
  // picked "This machine" but has not authorized it yet sees the local body's
  // pointer rather than a cloud browser they did not ask for.
  const isLocalBrowser = engine.selectedEngine === "local";
  const mintBrowserToken = useMintBrowserToken();

  // A tab that disappears cannot stay selected. Only a host losing the browser
  // capability can do that now — the engine switch swaps the body instead —
  // but leaving `activeTab` on a hidden pane hides all three and the rail looks
  // broken.
  useEffect(() => {
    if (!hasBrowser && activeTab === "browser") setActiveTab("logs");
  }, [hasBrowser, activeTab]);

  const handleTabClick = useCallback(
    (next: RightRailTab) => {
      if (next === activeTab) return;
      track("playground_right_rail_tab_changed", {
        location: "playground_right_rail",
        from: activeTab,
        to: next,
      });
      setActiveTab(next);
    },
    [activeTab],
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
        {/* Only when this host actually has the browser capability: a tab
            offering a browser the model cannot use would be a promise the
            host config does not keep. */}
        {hasBrowser ? (
          <TabButton
            icon={Globe}
            label="Browser"
            isActive={activeTab === "browser"}
            onClick={() => handleTabClick("browser")}
          />
        ) : null}
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
      {hasBrowser ? (
        <div
          className={cn(
            "min-h-0 flex-1 flex-col",
            activeTab === "browser" ? "flex" : "hidden",
          )}
        >
          {/* Mounted-hidden like the others: switching tabs must not drop the
              frame socket, which would stop the screencast and make the agent's
              browser go dark every time somebody glanced at the logs.

              `active` is what makes that safe. Mounted-hidden is not "being
              watched": both panes say somebody is looking in order to defer the
              idle reap, and a pane behind the Logs tab must stop claiming it —
              on the hosted engine that claim keeps a METERED box awake. */}
          {isLocalBrowser ? (
            <LocalBrowserBody
              projectId={projectId}
              consentGranted={engine.consent.granted}
              consentToken={engine.consent.token}
              active={activeTab === "browser"}
            />
          ) : (
            <HostedBrowserBody
              projectId={projectId}
              mintToken={mintBrowserToken}
              active={activeTab === "browser"}
            />
          )}
        </div>
      ) : null}
      <div
        className={cn(
          "min-h-0 flex-1 flex-col",
          activeTab === "shell" ? "flex" : "hidden",
        )}
      >
        {/* The local body deliberately does NOT mount the cloud terminal
            controller: `useComputerTerminal` reserves (and wakes) a cloud box
            on open, which would be a real machine started behind the user's
            back while their chat bash runs on this laptop. Swapping bodies
            mid-session drops a live cloud socket — the reserved box stays up
            until the idle sweep, and switching back reconnects with a fresh
            token mint. */}
        {isLocalShell ? (
          <LocalShellBody engine={engine} projectId={projectId} />
        ) : (
          <CloudShellBody
            engine={engine}
            projectId={projectId}
            isAuthenticated={isAuthenticated}
            hostConfig={hostConfig}
            hostId={hostId}
          />
        )}
      </div>
    </div>
  );
}

/** Which machine this project's computer work runs on. Indicator only. */
function RailEngineChip({ engine }: { engine: "local" | "cloud" }) {
  const isLocal = engine === "local";
  const Icon = isLocal ? Laptop : Cloud;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
      data-testid="rail-engine-chip"
      title="Switch engines from the Computer tab"
    >
      <Icon className="size-3" aria-hidden />
      {isLocal ? "This machine" : "Cloud computer"}
    </span>
  );
}

/**
 * The Shell body for the local engine: no cloud controller, no reserve — the
 * same bare `ComputerTerminal` the Computer tab's local face mounts, behind
 * the same explicit "Open terminal" gesture the cloud body uses. Explicit
 * because a PTY is a real shell on the user's machine: both rail bodies stay
 * mounted across Logs ⇄ Shell toggles, so mounting eagerly would open a shell
 * the moment the Playground loads, without the user asking for one.
 */
function LocalShellBody({
  engine,
  projectId,
}: {
  engine: ComputerEngineState;
  projectId: string | null;
}) {
  const { consent, localTerminalAvailable } = engine;
  const themeMode = usePreferencesStore((state) => state.themeMode);
  const [terminalOpen, setTerminalOpen] = useState(false);

  // A fresh nonce per (re)connect — single-use by construction, so the
  // reconnect button in `ComputerTerminal` must mint again rather than replay.
  const consentToken = consent.token;
  const mintToken = useCallback(
    () => mintLocalTerminalNonce({ projectId: projectId ?? "", consentToken }),
    [projectId, consentToken],
  );

  const canOpenTerminal =
    consent.granted && localTerminalAvailable && !!projectId;
  const showTerminal = terminalOpen && canOpenTerminal;

  // One `computer_terminal_opened` per opened SESSION, keyed like the Computer
  // tab's local face: a project switch remounts the terminal (new shell, new
  // workspace) and must be counted even though this component didn't remount.
  const lastReportedRef = useRef<string | null>(null);
  useEffect(() => {
    const key = showTerminal ? `open:${projectId}` : null;
    if (lastReportedRef.current === key) return;
    lastReportedRef.current = key;
    if (key === null) return;
    track("computer_terminal_opened", { location: "playground_rail_local" });
  }, [showTerminal, projectId]);

  return (
    <>
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        {/* Same `toggleVisible` gate as the cloud body: with only one engine
            available there is no choice to indicate, and the body copy below
            already names the machine. */}
        {engine.toggleVisible ? (
          <RailEngineChip engine={engine.engine} />
        ) : null}
        {!terminalOpen && canOpenTerminal ? (
          <Button size="sm" onClick={() => setTerminalOpen(true)}>
            <TerminalSquare className="mr-1.5 h-3.5 w-3.5" />
            Open terminal
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 px-3 pb-3">
        {!consent.granted ? (
          // A pointer, NOT a second consent gate: the Computer tab owns the
          // grant (and the blunt copy that goes with it).
          <PaneMessage dashed>
            <span data-testid="rail-local-unconsented">
              This machine isn&apos;t authorized yet. Open the Computer tab to
              allow agent commands here.
            </span>
          </PaneMessage>
        ) : showTerminal ? (
          // `uploadEnabled={false}` for the same reason as the Computer tab's
          // local pane: the drag-and-drop upload posts to the CLOUD box's
          // upload route, and writing dropped files onto the user's real
          // filesystem is a separate consent question.
          <ComputerTerminal
            // Keyed by project: `ComputerTerminal` connects from a MOUNT-ONLY
            // effect, so a project switch must remount into the new project's
            // workspace (and journal under it).
            key={projectId}
            mintToken={mintToken}
            themeMode={themeMode === "dark" ? "dark" : "light"}
            wsPath={LOCAL_TERMINAL_WS_PATH}
            uploadEnabled={false}
            className="h-full"
          />
        ) : canOpenTerminal ? (
          <PaneMessage dashed>
            <span data-testid="rail-local-terminal-pointer">
              Open the terminal to use a shell on this machine.
            </span>
          </PaneMessage>
        ) : (
          <PaneMessage dashed>
            <span data-testid="rail-local-terminal-unavailable">
              The terminal for this machine isn&apos;t available. Agents can
              still run bash commands here from chat.
            </span>
          </PaneMessage>
        )}
      </div>
    </>
  );
}

/** The Shell body for the cloud engine — unchanged behavior. */
function CloudShellBody({
  engine,
  projectId,
  isAuthenticated,
  hostConfig,
  hostId,
}: {
  engine: ComputerEngineState;
  projectId: string | null;
  isAuthenticated: boolean;
  hostConfig: HostConfigDtoV2 | null;
  hostId: string | null;
}) {
  // Bumped to remount (and thus reconnect) the terminal into the latest harness
  // workdir on demand — cwd only applies at connect time.
  const [reloadKey, setReloadKey] = useState(0);
  // One controller for the rail so the terminal session survives Logs ⇄ Shell
  // toggles (both bodies stay mounted; we only show/hide).
  const ct = useComputerTerminal({ projectId, isAuthenticated });
  // Open the terminal in the harness session workdir — but only for harness
  // hosts (plain computer hosts have no such dir → home).
  const isHarnessHost = !!hostConfig?.harness;
  // Read with the SAME key the chat stream writes (previewedHostId), not
  // hostConfig.id — those are different identifiers and would never match.
  const streamedWorkdir = useHarnessWorkdir(projectId, hostId);
  // COMP-16: open the terminal in the configured working directory. For a
  // harness host use the streamed per-session dir; for a plain computer host
  // fall back to the host-configured `computer.workdir` (the same dir the bash
  // tool runs in) so the Shell opens where the model works.
  const harnessCwd = isHarnessHost
    ? streamedWorkdir
    : hostConfig?.computer?.workdir;
  // Only offer "Open terminal" once the data-plane config has resolved to a
  // usable plane — opening while it's still loading mounts the terminal at the
  // page origin; opening with no plane reserves a computer it can't reach.
  const canOpenTerminal =
    ct.dataPlaneResolved &&
    !ct.dataPlaneUnavailable &&
    isAuthenticated &&
    !!projectId;

  return (
    <>
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <ComputerStatusChip
            status={ct.liveStatus}
            hibernatedReason={ct.status?.hibernatedReason}
          />
          {engine.toggleVisible ? <RailEngineChip engine="cloud" /> : null}
        </div>
        {!ct.terminalOpen && canOpenTerminal ? (
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
    </>
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
