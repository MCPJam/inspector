import { Button } from "@mcpjam/design-system/button";
import { Loader2, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { ComputerTerminal } from "./ComputerTerminal";
import type { ComputerTerminalController } from "./useComputerTerminal";

/**
 * The terminal body — the state machine that decides between the idle prompt,
 * the connecting/starting spinners, the live `<ComputerTerminal/>`, and the
 * error/gone messages. Driven by a `useComputerTerminal` controller, consumed
 * by the Playground right-rail Shell tab. (The full-page `ComputerView` renders
 * its own terminal body today — a candidate to migrate onto this pane.)
 */
export function ComputerTerminalPane({
  controller,
  className,
  cwd,
}: {
  controller: ComputerTerminalController;
  className?: string;
  /** Starting directory for the terminal (harness workdir); home if unset. */
  cwd?: string;
}) {
  const {
    status,
    liveStatus,
    isReady,
    isGone,
    terminalOpen,
    setTerminalOpen,
    starting,
    openTerminal,
    mintToken,
    terminalTheme,
    terminalBaseUrl,
    dataPlaneUnavailable,
    dataPlaneResolved,
  } = controller;

  const body = () => {
    if (dataPlaneUnavailable) {
      return (
        <PaneMessage dashed>
          <span className="max-w-md text-center">
            This inspector server isn't set up to run computers: it has no
            data-plane credentials and no remote data plane to delegate to. Set{" "}
            <code>COMPUTERS_REMOTE_DATA_PLANE_URL</code> (or the data-plane
            secrets) in the server environment to enable the terminal and the
            bash tool.
          </span>
        </PaneMessage>
      );
    }
    if (!terminalOpen) {
      return (
        <PaneMessage dashed>
          Open the terminal to start using your computer.
        </PaneMessage>
      );
    }
    // Don't mount the terminal until we know WHERE it lives: mounting while
    // the config fetch is in flight would aim the first WebSocket at the page
    // origin, and the mount-once effect never re-dials when the remote base
    // URL arrives a moment later.
    if (isReady && !dataPlaneResolved) {
      return (
        <PaneMessage>
          <span className="inline-flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Connecting to your computer…
          </span>
        </PaneMessage>
      );
    }
    if (isReady) {
      return (
        <ComputerTerminal
          mintToken={mintToken}
          themeMode={terminalTheme}
          className="h-full"
          {...(terminalBaseUrl ? { baseUrl: terminalBaseUrl } : {})}
          {...(cwd ? { cwd } : {})}
        />
      );
    }
    if (starting) {
      return (
        <PaneMessage>
          <span className="inline-flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Starting your computer…
          </span>
        </PaneMessage>
      );
    }
    if (liveStatus === "error") {
      return (
        <PaneMessage>
          <span>{status?.lastError || "The computer hit an error."}</span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void openTerminal()}
            >
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              Try again
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setTerminalOpen(false)}
            >
              Close
            </Button>
          </div>
        </PaneMessage>
      );
    }
    if (isGone) {
      return (
        <PaneMessage>
          This computer is no longer available.
          <Button
            size="sm"
            variant="outline"
            onClick={() => setTerminalOpen(false)}
          >
            Close
          </Button>
        </PaneMessage>
      );
    }
    // requested | provisioning | waking | hibernating | undefined (loading)
    return (
      <PaneMessage>
        <span className="inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Starting your computer…
        </span>
      </PaneMessage>
    );
  };

  return <div className={cn("min-h-0 flex-1", className)}>{body()}</div>;
}

export function PaneMessage({
  children,
  dashed = false,
}: {
  children: React.ReactNode;
  dashed?: boolean;
}) {
  return (
    <div
      className={`flex h-full flex-col items-center justify-center gap-3 rounded-md border text-sm text-muted-foreground ${
        dashed ? "border-dashed bg-muted/10" : "bg-muted/20"
      }`}
    >
      {children}
    </div>
  );
}
