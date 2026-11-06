import { Loader2, Settings, Share2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { DetailPageHeader } from "@/components/shared/detail-page-header";
import type { ConformanceView } from "./ConformancePageChrome";
import { ConformanceRunShareButton } from "./ConformanceRunActions";
import { detailDateFormat } from "./ConformanceHistory";

const RUN_VIEWS = [
  { value: "overview", label: "Overview" },
  { value: "history", label: "History" },
] as const;

/**
 * A run on screen: the same chrome as a Swarm or User Testing page (back,
 * title, the page's tabs) with the run's own actions on the right.
 */
export function ConformanceRunHeader({
  serverName,
  startedAt,
  onBack,
  busy,
  isConnecting,
  showHistory,
  onShowHistory,
  onOpenSettings,
  settingsLoading,
  showShare,
  savedRunId,
  onRunAgain,
  runDisabled,
}: {
  serverName: string;
  startedAt: number | null;
  /** Back to the Conformance page's server list. */
  onBack: () => void;
  /** Running or connecting: leaving now would lose the run. */
  busy: boolean;
  isConnecting: boolean;
  showHistory: boolean;
  onShowHistory: () => void;
  onOpenSettings?: () => void;
  settingsLoading?: boolean;
  /** The run is saved, so it can be shared once it finishes. */
  showShare: boolean;
  savedRunId?: string | null;
  onRunAgain: () => void;
  runDisabled: boolean;
}) {
  return (
    <DetailPageHeader
      backLabel="Conformance"
      onBack={onBack}
      // Going back resets the page. Without History (no project) a finished
      // run could not be found again, so it stays until the next run.
      backDisabled={busy || !showHistory}
      backTestId="conformance-run-back"
      title={
        <h1
          className="truncate text-xl font-bold tracking-tight text-foreground"
          title={serverName}
        >
          {serverName}
        </h1>
      }
      tabs={
        showHistory
          ? {
              value: "overview" as ConformanceView,
              options: RUN_VIEWS,
              onChange: (next) => {
                if (next === "history") onShowHistory();
              },
              ariaLabel: "Conformance view",
              indicatorId: "conformance-run-view",
            }
          : undefined
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
                serverName={serverName}
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
