import { Component, useCallback, useState } from "react";
import { toast } from "@/lib/toast";
import { usePostHog } from "posthog-js/react";
import { Button } from "@mcpjam/design-system/button";
import { Boxes, Loader2, RotateCcw, TerminalSquare, Trash2 } from "lucide-react";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import {
  useComputersDataPlaneConfig,
  useComputerStatus,
  useComputerUsage,
  useDeleteComputer,
  useMintTerminalToken,
  useReserveComputer,
} from "@/hooks/useProjectComputer";
import {
  useEnvironments,
  useResetComputer,
} from "@/hooks/useComputerEnvironments";
import { EnvironmentsDrawer } from "./EnvironmentsDrawer";
import { toTerminalWsBase } from "@/lib/computer-terminal-connection";
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
  const [envDrawerOpen, setEnvDrawerOpen] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  const resetComputer = useResetComputer();
  const environments = useEnvironments(effectiveProjectId);
  const attachedEnvironmentId = status?.environmentId ?? null;
  const attachedEnvName =
    attachedEnvironmentId == null
      ? null
      : environments?.find((e) => e.environmentId === attachedEnvironmentId)
          ?.name ?? null;

  // Where the terminal lives: this server (local data plane), a deployed
  // data plane (remote URL → cross-origin WS), or nowhere (honest empty
  // state instead of a Ready badge next to a terminal that can't connect).
  const dataPlane = useComputersDataPlaneConfig();
  const remoteWsBase = dataPlane?.remoteDataPlaneUrl
    ? toTerminalWsBase(dataPlane.remoteDataPlaneUrl)
    : undefined;
  const terminalBaseUrl =
    dataPlane && !dataPlane.localConfigured ? remoteWsBase : undefined;
  const dataPlaneUnavailable =
    dataPlane !== undefined && !dataPlane.localConfigured && !remoteWsBase;

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

  const onReset = useCallback(async () => {
    if (!effectiveProjectId) return;
    setResetting(true);
    try {
      const res = await resetComputer({ projectId: effectiveProjectId });
      toast.success(
        res.reset ? "Resetting your computer to its image…" : "Nothing to reset."
      );
    } catch (err) {
      toast.error(getBillingErrorMessage(err, "Could not reset the computer."));
    } finally {
      setResetting(false);
      setConfirmingReset(false);
    }
  }, [effectiveProjectId, resetComputer]);

  // Reset and image changes both rebuild the box, so only offer them when it's
  // settled (not mid-provision).
  const canReset = isReady || liveStatus === "hibernating";

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
    if (isReady && dataPlane === undefined) {
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
          {!terminalOpen && !dataPlaneUnavailable ? (
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

      {status !== undefined ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/10 px-3 py-2 text-sm">
          <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
            <Boxes className="h-4 w-4 shrink-0" />
            Image:
            <span className="truncate font-medium text-foreground">
              {attachedEnvName ?? "Base image"}
            </span>
            {attachedEnvName ? null : (
              <span className="hidden sm:inline">Debian + Node + Python</span>
            )}
          </span>
          <span className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEnvDrawerOpen(true)}
            >
              Change
            </Button>
            {hasComputer ? (
              confirmingReset ? (
                <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                  Reset to the image? Installed files are wiped.
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => void onReset()}
                    disabled={resetting}
                  >
                    {resetting ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    Reset
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmingReset(false)}
                    disabled={resetting}
                  >
                    Cancel
                  </Button>
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmingReset(true)}
                  disabled={!canReset}
                  title={
                    canReset
                      ? undefined
                      : "Reset is available once the computer is ready or asleep"
                  }
                >
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                  Reset
                </Button>
              )
            ) : null}
          </span>
        </div>
      ) : null}

      {effectiveProjectId ? (
        <EnvironmentsDrawer
          open={envDrawerOpen}
          onOpenChange={setEnvDrawerOpen}
          projectId={effectiveProjectId}
          attachedEnvironmentId={attachedEnvironmentId}
        />
      ) : null}

      <UsageMeterBoundary>
        <ComputerUsageMeter projectId={projectId} />
      </UsageMeterBoundary>

      {liveStatus === "error" && status?.lastError ? (
        <div className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {status.lastError}
        </div>
      ) : null}

      <div className="min-h-0 flex-1">{renderTerminalPane()}</div>
    </div>
  );
}

/**
 * Awake-time meter for the project's org: "X of Y free hours this month, then
 * N credits/hour, sleeping is free". Hidden while loading, when the backend
 * resolves no meter, or when the deployment isn't metering (`mode: "off"`).
 */
function ComputerUsageMeter({ projectId }: { projectId: string }) {
  const usage = useComputerUsage(projectId);
  if (!usage || usage.mode === "off") return null;

  const { awakeMs, allowanceMs, creditsPerHour, billedCredits } = usage;
  const overAllowance = allowanceMs !== null && awakeMs > allowanceMs;
  // A zero-hour allowance with any usage reads as a full (over) bar, not an
  // empty one. No such plan exists today, but the meter shouldn't lie if one
  // ships.
  const usedPct =
    allowanceMs === null
      ? 0
      : allowanceMs <= 0
      ? awakeMs > 0
        ? 100
        : 0
      : Math.min(100, (awakeMs / allowanceMs) * 100);

  return (
    <div
      data-testid="computer-usage-meter"
      className="flex flex-col gap-2 rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span>
          Awake time this month:{" "}
          <span className="font-medium text-foreground">
            {formatAwakeDuration(awakeMs)}
          </span>
          {allowanceMs !== null ? (
            <> of {formatAwakeDuration(allowanceMs)} free</>
          ) : (
            <> — included with your plan</>
          )}
        </span>
        {allowanceMs !== null ? (
          <span>
            {billedCredits > 0 ? (
              <>
                <span className="font-medium text-foreground">
                  {billedCredits} credits
                </span>{" "}
                used ·{" "}
              </>
            ) : (
              <>then </>
            )}
            {creditsPerHour} credits/hour · sleeping is free
          </span>
        ) : null}
      </div>
      {allowanceMs !== null ? (
        <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            data-testid="computer-usage-meter-fill"
            className={`h-full rounded-full ${
              overAllowance ? "bg-destructive" : "bg-primary"
            }`}
            style={{ width: `${usedPct}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

// Sub-hour spans read as minutes; everything else as hours with one decimal
// ("4.2 h"), trailing-zero trimmed ("30 h").
function formatAwakeDuration(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes < 60) return `${Math.round(minutes)} min`;
  return `${Number((minutes / 60).toFixed(1))} h`;
}

/**
 * The meter is a progressive enhancement: against a backend that predates
 * `getComputerUsage`, the Convex query throws during render — swallow it and
 * show no meter instead of taking down the whole Computer tab.
 */
class UsageMeterBoundary extends Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
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
