import { Loader2, Settings, Share2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { DetailPageHeader } from "@/components/shared/detail-page-header";
import { ConformanceRunShareButton } from "./ConformanceRunActions";
import { detailDateFormat } from "./ConformanceHistory";

/**
 * A run on screen: back and title, with the run's own actions on the right.
 * No Overview/History tabs: the run is not one of the page's views.
 */
export function ConformanceRunHeader({
  serverName,
  startedAt,
  backLabel,
  onBack,
  busy,
  isConnecting,
  showHistory,
  onOpenSettings,
  settingsLoading,
  showShare,
  savedRunId,
  shareServerName,
  onRunAgain,
  runDisabled,
}: {
  serverName: string;
  startedAt: number | null;
  /** Where Back goes: the tab the run was started from. */
  backLabel: string;
  onBack: () => void;
  /** Running or connecting: leaving now would lose the run. */
  busy: boolean;
  isConnecting: boolean;
  showHistory: boolean;
  onOpenSettings?: () => void;
  settingsLoading?: boolean;
  /** The run is saved, so it can be shared once it finishes. */
  showShare: boolean;
  savedRunId?: string | null;
  /**
   * The name the share card shows: set only when the run is saved against a
   * saved server, so the card reads the same here and reopened from History.
   */
  shareServerName?: string;
  onRunAgain: () => void;
  runDisabled: boolean;
}) {
  return (
    <DetailPageHeader
      backLabel={backLabel}
      onBack={onBack}
      // Going back resets the page. Without History (no project) a finished
      // run could not be found again, so it stays until the next run.
      backDisabled={busy || !showHistory}
      backTestId="conformance-run-back"
      stackWhenNarrow
      title={
        <h1
          className="truncate text-xl font-bold tracking-tight text-foreground"
          title={serverName}
        >
          {serverName}
        </h1>
      }
      actions={
        <>
          {onOpenSettings ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onOpenSettings}
              disabled={settingsLoading}
            >
              <Settings className="size-3.5" aria-hidden /> Settings
            </Button>
          ) : null}
          {showShare ? (
            savedRunId ? (
              <ConformanceRunShareButton
                runId={savedRunId}
                finished={!busy}
                serverName={shareServerName}
              />
            ) : (
              // Not saved yet: Share waits for the run to finish.
              <Button variant="outline" size="sm" disabled>
                <Share2 className="size-3.5" aria-hidden /> Share
              </Button>
            )
          ) : null}
          <Button
            size="sm"
            onClick={onRunAgain}
            disabled={busy || settingsLoading || runDisabled}
          >
            {busy ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                {isConnecting ? "Connecting..." : "Running..."}
              </>
            ) : (
              "Run again"
            )}
          </Button>
        </>
      }
    >
      {startedAt ? (
        <p className="text-sm text-muted-foreground">
          {detailDateFormat.format(startedAt)} · UI
        </p>
      ) : null}
    </DetailPageHeader>
  );
}
