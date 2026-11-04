/**
 * What a saved run's page offers beside its results: the server's Settings,
 * Share, and Run again. Run again starts a new run of the same server with
 * its default checks, as the server list's Run does.
 */

import { useState } from "react";
import { Settings, Share2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { ShareDialog } from "@/components/sharing/ShareDialog";
import { ResourceSharePanel } from "@/components/sharing/ResourceSharePanel";
import type { ConformanceSelection } from "@/hooks/use-conformance-run";
import {
  buildConformanceRunServerPath,
  buildConformanceSharePath,
  useAppNavigate,
} from "@/lib/app-navigation";
import { ConformanceSettings } from "./ConformanceSettings";

/** The project's saved default checks, read and written by server name. */
export type SavedRunServerSettings = {
  defaults?: Record<string, ConformanceSelection>;
  /** False while `defaults` is still loading. */
  loaded: boolean;
  save: (serverName: string, selection: ConformanceSelection) => Promise<void>;
};

/**
 * Share for one saved run: opens the share dialog. Only a finished run can be
 * shared.
 */
export function ConformanceRunShareButton({
  runId,
  finished,
}: {
  runId: string;
  finished: boolean;
}) {
  const [shareOpen, setShareOpen] = useState(false);

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={!finished}
        onClick={() => setShareOpen(true)}
        data-testid="conformance-share-open"
      >
        <Share2 className="size-3.5" aria-hidden /> Share
      </Button>
      <ShareDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        title="Share conformance run"
        description="A redacted snapshot of this run."
      >
        <ResourceSharePanel
          resourceType="conformanceRun"
          resourceId={runId}
          disabledReason={finished ? null : "Only a finished run can be shared"}
          footerSlot={
            <p className="text-xs text-muted-foreground">
              Viewers see a frozen snapshot. Revoking access takes effect
              immediately.
            </p>
          }
          linkLabel="Share link"
          buildShareUrl={(token) =>
            `${window.location.origin}${buildConformanceSharePath(token)}`
          }
          testIdPrefix="conformance-share"
          invites={false}
        />
      </ShareDialog>
    </>
  );
}

/**
 * Settings, Share and Run again for a saved run. `serverName` is set only
 * when the project still has the run's server: without it there is nothing
 * to configure, and Run again goes to the Conformance page to pick one.
 */
export function SavedRunActions({
  runId,
  finished,
  serverName,
  settings,
  onOpenSettings,
  serversLoading = false,
}: {
  runId: string;
  finished: boolean;
  serverName?: string;
  settings?: SavedRunServerSettings;
  onOpenSettings: () => void;
  serversLoading?: boolean;
}) {
  const navigate = useAppNavigate();
  return (
    <div className="ml-auto flex items-center gap-2">
      {serverName && settings ? (
        <Button
          variant="outline"
          size="sm"
          onClick={onOpenSettings}
          // Opened before they load, Settings would start from every check
          // and a change would save over the real defaults.
          disabled={serversLoading || !settings.loaded}
        >
          <Settings className="size-3.5" aria-hidden /> Settings
        </Button>
      ) : null}
      <ConformanceRunShareButton runId={runId} finished={finished} />
      <Button
        size="sm"
        disabled={serversLoading}
        onClick={() =>
          navigate(
            serverName
              ? buildConformanceRunServerPath(serverName)
              : "/conformance",
          )
        }
      >
        Run again
      </Button>
    </div>
  );
}

/** The run's server Settings, in place of the run until Back. */
export function SavedRunSettings({
  serverName,
  settings,
  onBack,
}: {
  serverName: string;
  settings: SavedRunServerSettings;
  onBack: () => void;
}) {
  const [pendingSaves, setPendingSaves] = useState(0);
  return (
    <ConformanceSettings
      serverName={serverName}
      defaults={settings.defaults?.[serverName]}
      onSave={async (selection) => {
        setPendingSaves((count) => count + 1);
        try {
          await settings.save(serverName, selection);
        } finally {
          setPendingSaves((count) => count - 1);
        }
      }}
      backDisabled={pendingSaves > 0}
      onBack={onBack}
    />
  );
}
