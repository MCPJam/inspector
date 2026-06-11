import { useCallback, useState } from "react";
import { toast } from "sonner";
import { usePostHog } from "posthog-js/react";
import { Button } from "@mcpjam/design-system/button";
import { Loader2, RotateCcw, TerminalSquare, Trash2 } from "lucide-react";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import {
  useComputerStatus,
  useDeleteComputer,
  useMintTerminalToken,
  useReserveComputer,
} from "@/hooks/useProjectComputer";
import {
  getBillingErrorMessage,
  isComputerStartLimitError,
} from "@/lib/billing-entitlements";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";
import { ComputerStatusChip } from "./ComputerStatusChip";
import { ComputerTerminal } from "./ComputerTerminal";

/**
 * The "Computer" tab — manage the project's personal cloud computer (one per
 * project, per user): see its status, open a live terminal, or delete it.
 * Gated behind the `computers-enabled` PostHog flag by its route.
 */
export function ComputerView({
  projectId,
  isAuthenticated,
}: {
  projectId: string | null;
  isAuthenticated: boolean;
}) {
  const effectiveProjectId = isAuthenticated ? projectId : null;
  const status = useComputerStatus(effectiveProjectId);
  const reserve = useReserveComputer();
  const deleteComputer = useDeleteComputer();
  const mintTerminalToken = useMintTerminalToken();
  const posthog = usePostHog();
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const terminalTheme = themeMode === "dark" ? "dark" : "light";

  const [terminalOpen, setTerminalOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const liveStatus = status === undefined ? undefined : status?.status ?? null;
  const isReady = liveStatus === "ready";
  // "Gone" = no computer row, or one that's been (or is being) torn down.
  // Nothing to delete and nothing for an open terminal to attach to.
  const isGone =
    liveStatus === null ||
    liveStatus === "deleted" ||
    liveStatus === "deleting";
  const hasComputer = liveStatus !== undefined && !isGone;

  const mintToken = useCallback(async () => {
    if (!effectiveProjectId) throw new Error("No project selected.");
    const result = await mintTerminalToken({ projectId: effectiveProjectId });
    return result.token;
  }, [effectiveProjectId, mintTerminalToken]);

  const openTerminal = useCallback(async () => {
    if (!effectiveProjectId) return;
    posthog?.capture("computer_terminal_opened", {
      computer_status: liveStatus ?? "none",
    });
    setTerminalOpen(true);
    if (liveStatus !== "ready") {
      // Provision-on-first-use / wake; the live status query then drives the
      // terminal to mount once it reports ready.
      setStarting(true);
      try {
        await reserve({ projectId: effectiveProjectId });
      } catch (err) {
        setTerminalOpen(false);
        if (isComputerStartLimitError(err)) {
          // Daily start cap — the limit dialog carries the conversion CTA
          // (sign-in for guests, top-up for signed-in users).
          posthog?.capture("computer_start_limit_hit");
          useMCPJamLimitDialogStore.getState().notifyLimitHit();
        } else {
          toast.error(
            getBillingErrorMessage(err, "Could not start the computer.")
          );
        }
      } finally {
        setStarting(false);
      }
    }
  }, [effectiveProjectId, liveStatus, posthog, reserve]);

  const onDelete = useCallback(async () => {
    if (!effectiveProjectId) return;
    setDeleting(true);
    try {
      await deleteComputer({ projectId: effectiveProjectId });
      setTerminalOpen(false);
      toast.success("Computer deleted.");
    } catch (err) {
      toast.error(
        getBillingErrorMessage(err, "Could not delete the computer.")
      );
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  }, [effectiveProjectId, deleteComputer]);

  if (!isAuthenticated) {
    return <Empty>Sign in to use a personal computer for this project.</Empty>;
  }
  if (!projectId) {
    return (
      <Empty>
        Project Computers need a synced project. Create or open a project to get
        started.
      </Empty>
    );
  }

  const renderTerminalPane = () => {
    if (!terminalOpen) {
      return (
        <PaneMessage dashed>
          Open the terminal to start using your computer.
        </PaneMessage>
      );
    }
    if (isReady) {
      return (
        <ComputerTerminal
          mintToken={mintToken}
          themeMode={terminalTheme}
          className="h-full"
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

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-foreground">Computer</h1>
          <ComputerStatusChip status={liveStatus} />
        </div>
        <div className="flex items-center gap-2">
          {!terminalOpen ? (
            <Button
              size="sm"
              onClick={() => void openTerminal()}
              disabled={starting}
            >
              {starting ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <TerminalSquare className="mr-1.5 h-3.5 w-3.5" />
              )}
              Open terminal
            </Button>
          ) : null}
          {hasComputer ? (
            confirmingDelete ? (
              <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                Delete this computer?
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => void onDelete()}
                  disabled={deleting}
                >
                  {deleting ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  Delete
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={deleting}
                >
                  Cancel
                </Button>
              </span>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConfirmingDelete(true)}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                Delete
              </Button>
            )
          ) : null}
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        A personal Linux workstation for this project — files and installed
        tools persist between sessions; it sleeps when idle and wakes on use.
      </p>

      {liveStatus === "error" && status?.lastError ? (
        <div className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {status.lastError}
        </div>
      ) : null}

      <div className="min-h-0 flex-1">{renderTerminalPane()}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function PaneMessage({
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
