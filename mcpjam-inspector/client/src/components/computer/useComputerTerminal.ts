import { useCallback, useState } from "react";
import { toast } from "@/lib/toast";
import { usePostHog } from "posthog-js/react";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import {
  useComputersDataPlaneConfig,
  useComputerStatus,
  useDeleteComputer,
  useMintTerminalToken,
  useReserveComputer,
} from "@/hooks/useProjectComputer";
import { toTerminalWsBase } from "@/lib/computer-terminal-connection";
import {
  getBillingErrorMessage,
  isComputerStartLimitError,
} from "@/lib/billing-entitlements";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";

/**
 * Shared wiring for the project computer's live terminal — status, data-plane
 * resolution, token minting, and the provision-on-open / wake flow. No JSX: the
 * Playground right-rail Shell tab consumes this and renders its own chrome
 * (`ComputerTerminalPane` renders the body). The full-page `ComputerView` still
 * has its own duplicate copy of this wiring — a candidate to migrate onto this
 * hook so there's one authoritative implementation.
 */
export function useComputerTerminal({
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
  const terminalTheme: "light" | "dark" =
    themeMode === "dark" ? "dark" : "light";

  const [terminalOpen, setTerminalOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
    // Don't open/reserve until the data-plane config has resolved AND a usable
    // plane exists. Opening while `dataPlane` is still loading would mount the
    // terminal (first WebSocket aims at the page origin), and opening when no
    // plane is configured would reserve a computer the terminal can never reach.
    if (!effectiveProjectId || dataPlane === undefined || dataPlaneUnavailable)
      return;
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
  }, [
    effectiveProjectId,
    dataPlane,
    dataPlaneUnavailable,
    liveStatus,
    posthog,
    reserve,
  ]);

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
    }
  }, [effectiveProjectId, deleteComputer]);

  return {
    /** Raw lifecycle status: undefined = loading, null = no computer. */
    status,
    liveStatus,
    isReady,
    isGone,
    hasComputer,
    terminalOpen,
    setTerminalOpen,
    starting,
    deleting,
    openTerminal,
    onDelete,
    mintToken,
    terminalTheme,
    terminalBaseUrl,
    dataPlaneUnavailable,
    /** False while the data-plane config is still loading — don't mount the
     *  terminal yet or the first WebSocket aims at the page origin. */
    dataPlaneResolved: dataPlane !== undefined,
  };
}

export type ComputerTerminalController = ReturnType<typeof useComputerTerminal>;
