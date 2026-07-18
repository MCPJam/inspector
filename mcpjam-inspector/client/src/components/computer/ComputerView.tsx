import { Component, useCallback, useState } from "react";
import { toast } from "@/lib/toast";
import { track } from "@/lib/analytics";
import { Button } from "@mcpjam/design-system/button";
import {
  Boxes,
  Info,
  Loader2,
  Moon,
  RotateCcw,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import {
  ComputerBillingWarningBanner,
  ComputerPausedForBillingNotice,
} from "./ComputerBillingNotices";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import {
  useComputersDataPlaneConfig,
  useComputerStatus,
  useComputerUsage,
  useDeleteComputer,
  useHibernateComputer,
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
import { useSurfaceAgentBridge } from "@/lib/webmcp/use-surface-agent-bridge";
import { createInspectorCommandClientError } from "@/lib/inspector-command-handlers";
import { ComputerStatusChip } from "./ComputerStatusChip";
import { ComputerTerminal } from "./ComputerTerminal";
import { ComputersUnavailableMessage } from "./ComputersUnavailableMessage";
import { PaneMessage } from "./PaneMessage";

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
  const hibernateComputer = useHibernateComputer();
  const mintTerminalToken = useMintTerminalToken();
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const terminalTheme = themeMode === "dark" ? "dark" : "light";

  const [terminalOpen, setTerminalOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingHibernate, setConfirmingHibernate] = useState(false);
  const [hibernating, setHibernating] = useState(false);
  const [envDrawerOpen, setEnvDrawerOpen] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  const resetComputer = useResetComputer();
  const environments = useEnvironments(effectiveProjectId);
  const attachedEnvironmentId = status?.environmentId ?? null;
  const hasCustomImage = attachedEnvironmentId != null;
  const attachedEnvName = hasCustomImage
    ? environments?.find((e) => e.environmentId === attachedEnvironmentId)
        ?.name ?? null
    : null;
  // A custom image is attached but its name hasn't resolved yet (list still
  // loading, or it's not visible to this caller) — don't mislabel it as base.
  const imageLabel = !hasCustomImage
    ? "Base image"
    : attachedEnvName ?? "Custom image";

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
  const hibernatedReason = status?.hibernatedReason;
  // Paused because compute hours ran out and the wallet couldn't cover the
  // overage (COMP-7) — distinct from an idle sleep the user can just wake.
  const isBillingPaused =
    liveStatus === "hibernating" && hibernatedReason === "billing";
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
    track("computer_terminal_opened", {
      location: "computer_view",
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
          track("computer_start_limit_hit", { location: "computer_view" });
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
  }, [effectiveProjectId, liveStatus, reserve]);

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

  const onHibernate = useCallback(async () => {
    if (!effectiveProjectId) return;
    setHibernating(true);
    try {
      await hibernateComputer({ projectId: effectiveProjectId });
      setTerminalOpen(false);
      toast.success("Computer hibernated. It'll wake next time you use it.");
    } catch (err) {
      toast.error(
        getBillingErrorMessage(err, "Could not hibernate the computer.")
      );
    } finally {
      setHibernating(false);
      setConfirmingHibernate(false);
    }
  }, [effectiveProjectId, hibernateComputer]);

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
  // settled (not mid-provision). Attaching is also allowed when there's no
  // computer yet (the backend provisions-with-pin on first use).
  const canReset = isReady || liveStatus === "hibernating";
  const canAttach = liveStatus === null || canReset;

  // --- Agent tool group (surface "computer") ----------------------------
  //
  // ComputerView owns the single computer's status and the lifecycle action
  // hooks, so the tools exist exactly while /computer is mounted. Handlers call
  // the SAME gated callbacks the buttons use, behind the SAME gates:
  //  - unavailable here (no signed-in project, or no data plane) →
  //    `unsupported_in_mode`, matching where the buttons are inert;
  //  - the daily start cap is enforced server-side on reserve, so
  //    `startComputer` reserves exactly like the Open-terminal button and
  //    surfaces a cap rejection as `execution_failed` naming the cap.
  // The interactive TERMINAL is deliberately not a tool — opening it mints a
  // token and drops a human into a shell; the snapshot reports terminal-open,
  // never the token.
  const requireComputerProject = (): string => {
    if (!effectiveProjectId) {
      throw createInspectorCommandClientError(
        "unsupported_in_mode",
        "The Computer tools need a signed-in project — sign in and select a project first.",
      );
    }
    if (dataPlaneUnavailable) {
      throw createInspectorCommandClientError(
        "unsupported_in_mode",
        "Computers aren't available in this deployment (no data plane), so the Computer tools are off.",
      );
    }
    return effectiveProjectId;
  };

  useSurfaceAgentBridge({
    surfaceId: "computer",
    handlers: {
      startComputer: async () => {
        const pid = requireComputerProject();
        try {
          // The SAME reserve path the Open-terminal button uses (minus opening
          // the interactive terminal): the daily start cap is enforced here by
          // the backend.
          const view = await reserve({ projectId: pid });
          return {
            status: "computer_starting",
            computerStatus: view?.status ?? liveStatus ?? "requested",
            note: "The computer is provisioning/waking in the background — watch ui_snapshot_app for it to reach 'ready'. This did NOT open the interactive terminal (that's a human action).",
          };
        } catch (err) {
          if (isComputerStartLimitError(err)) {
            // Daily start cap hit — report the cap, never a bypass.
            throw createInspectorCommandClientError(
              "execution_failed",
              getBillingErrorMessage(err, "Daily computer start limit reached."),
            );
          }
          throw createInspectorCommandClientError(
            "execution_failed",
            getBillingErrorMessage(err, "Could not start the computer."),
          );
        }
      },
      hibernateComputer: async () => {
        const pid = requireComputerProject();
        try {
          const res = await hibernateComputer({ projectId: pid });
          setTerminalOpen(false);
          return {
            status: res.hibernated ? "computer_hibernating" : "nothing_to_hibernate",
            hibernated: res.hibernated,
          };
        } catch (err) {
          throw createInspectorCommandClientError(
            "execution_failed",
            getBillingErrorMessage(err, "Could not hibernate the computer."),
          );
        }
      },
      resetComputer: async () => {
        const pid = requireComputerProject();
        try {
          const res = await resetComputer({ projectId: pid });
          return {
            status: res.reset ? "computer_resetting" : "nothing_to_reset",
            reset: res.reset,
          };
        } catch (err) {
          throw createInspectorCommandClientError(
            "execution_failed",
            getBillingErrorMessage(err, "Could not reset the computer."),
          );
        }
      },
      deleteComputer: async () => {
        const pid = requireComputerProject();
        try {
          const res = await deleteComputer({ projectId: pid });
          setTerminalOpen(false);
          return { status: "computer_deleted", deleted: res.deleted };
        } catch (err) {
          throw createInspectorCommandClientError(
            "execution_failed",
            getBillingErrorMessage(err, "Could not delete the computer."),
          );
        }
      },
    },
    // Redacted STATE only: lifecycle status, attached environment, and an
    // availability summary. NEVER the terminal token or any credential.
    snapshot: () => {
      if (!effectiveProjectId) {
        return {
          gated: true,
          reason: "Sign in and select a project to use the Computer tools.",
        };
      }
      if (dataPlaneUnavailable) {
        return {
          gated: true,
          reason: "Computers aren't available in this deployment.",
        };
      }
      return {
        status: liveStatus === undefined ? "loading" : liveStatus ?? "none",
        hasComputer,
        isReady,
        hibernatedReason: hibernatedReason ?? null,
        billingPaused: isBillingPaused,
        environment: attachedEnvironmentId
          ? { id: attachedEnvironmentId, name: attachedEnvName ?? null }
          : null,
        imageLabel,
        terminalOpen,
        // Short, redacted error text only (no stack, no payload).
        lastError: status?.lastError ? status.lastError.slice(0, 300) : null,
      };
    },
  });

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
      return <ComputersUnavailableMessage />;
    }
    // Billing pause is a distinct state: the terminal can't open until credits
    // land or the allowance resets, so state the reason + remedy instead of an
    // idle prompt or a spinner that would bounce straight back to sleep.
    if (isBillingPaused) {
      return <ComputerPausedForBillingNotice />;
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
          <ComputerStatusChip
            status={liveStatus}
            hibernatedReason={hibernatedReason}
          />
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
          {isReady ? (
            confirmingHibernate ? (
              <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                Hibernate now?
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void onHibernate()}
                  disabled={hibernating}
                >
                  {hibernating ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  Hibernate
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmingHibernate(false)}
                  disabled={hibernating}
                >
                  Cancel
                </Button>
              </span>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConfirmingHibernate(true)}
                title="Put the computer to sleep now (state is kept; wakes on next use)"
              >
                <Moon className="mr-1.5 h-3.5 w-3.5" />
                Hibernate now
              </Button>
            )
          ) : null}
          {hasComputer ? (
            confirmingDelete ? (
              <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                Delete this computer? All files on it will be deleted.
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

      <div className="flex flex-col gap-1.5">
        <p className="text-sm text-muted-foreground">
          A personal Linux workstation for this project. It sleeps automatically
          after about 30 minutes idle, or shortly after you close the terminal,
          and wakes on use. Use “Hibernate now” to put it to sleep immediately.
        </p>
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Files persist when your computer sleeps, but they aren't backed up —
            keep anything important in git or elsewhere.
          </span>
        </p>
      </div>

      {/* Degrade like the meter: the shared query throws against a backend that
          predates it, so hide the banner rather than blank the whole tab. */}
      <UsageMeterBoundary>
        <ComputerBillingWarningBanner projectId={projectId} />
      </UsageMeterBoundary>

      {status !== undefined ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/10 px-3 py-2 text-sm">
          <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
            <Boxes className="h-4 w-4 shrink-0" />
            Image:
            <span className="truncate font-medium text-foreground">
              {imageLabel}
            </span>
            {hasCustomImage ? null : (
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
                  Reset to the image? All files on this computer will be
                  deleted.
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
          canAttach={canAttach}
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

