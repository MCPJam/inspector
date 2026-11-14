/**
 * What a saved run's page offers beside its results: the server's Settings,
 * Share, and Run again. Run again starts a new run of the same server with
 * its default checks, as the server list's Run does.
 */

import { useEffect, useState } from "react";
import { Settings, Share2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import type { ConformanceSelection } from "@/hooks/use-conformance-run";
import {
  buildConformanceRunServerPath,
  useAppNavigate,
} from "@/lib/app-navigation";
import { ConformanceShareRunDialog } from "./share/ConformanceShareRunDialog";
import type { ServerWithName } from "@/hooks/use-app-state";
import type { ConformanceProbes } from "@/hooks/use-conformance-probes";
import type { ConformanceDefaults } from "@/hooks/use-conformance-server-data";
import type { ConformanceConnectServer } from "./ConformancePanel";
import { ConformanceDefaultsError } from "./ConformanceDefaultsError";
import { ConformanceSettings } from "./ConformanceSettings";

/** The project's saved default checks, read and written by server name. */
export type SavedRunServerSettings = {
  defaults?: Record<string, ConformanceSelection>;
  /** False while `defaults` is still loading. */
  loaded: boolean;
  inputs?: Record<string, ConformanceProbes>;
  servers?: Record<string, ServerWithName>;
  connect?: ConformanceConnectServer;
  load?: (serverName: string) => Promise<ConformanceDefaults>;
  save: (
    serverName: string,
    selection: ConformanceSelection,
    inputs?: ConformanceProbes,
  ) => Promise<void>;
  /** Each server's saved run timeout override, by name. */
  timeouts?: Record<string, number>;
  /** Saves a server's run timeout; null goes back to the default. */
  saveTimeout?: (serverName: string, seconds: number | null) => Promise<void>;
};

/**
 * Share for one saved run: opens the run's score card, to download or post,
 * with its link and access settings. Only a finished run can be shared.
 * `serverName` titles the card; the public link's preview never shows it.
 */
export function ConformanceRunShareButton({
  runId,
  finished,
  serverName,
}: {
  runId: string;
  finished: boolean;
  serverName?: string;
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
      <ConformanceShareRunDialog
        runId={runId}
        serverName={serverName}
        finished={finished}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />
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
    // Wraps when the header stacks it on a narrow window.
    <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
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
      {/* Only a saved server's own name goes on the card. A run without one
          would fall back to its target key (a URL or a raw id), and the card
          and post are public; with no name, the card shows none. */}
      <ConformanceRunShareButton
        runId={runId}
        finished={finished}
        serverName={serverName}
      />
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
  const [initial, setInitial] = useState<ConformanceDefaults | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const load = settings.load;
  useEffect(() => {
    if (!load) return;
    let active = true;
    setFailed(false);
    void load(serverName).then(
      (defaults) => {
        if (active) setInitial(defaults);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [load, serverName, attempt]);
  if (load && !initial)
    return (
      <div>
        <Button variant="link" onClick={onBack}>
          Back
        </Button>
        {failed ? (
          <ConformanceDefaultsError
            onRetry={() => setAttempt((prev) => prev + 1)}
          />
        ) : (
          <p role="status" className="p-8 text-sm">
            Loading defaults...
          </p>
        )}
      </div>
    );
  return (
    <ConformanceSettings
      key={serverName}
      serverName={serverName}
      server={settings.servers?.[serverName]}
      onConnectServer={settings.connect}
      defaults={settings.defaults?.[serverName] ?? initial?.selection}
      inputs={settings.inputs?.[serverName] ?? initial?.inputs}
      onSave={(selection, inputs) =>
        settings.save(serverName, selection, inputs)
      }
      timeoutSeconds={
        // `Object.hasOwn`, as the Conformance page reads the same map: a
        // server named like a built-in ("constructor") must not get one.
        settings.timeouts && Object.hasOwn(settings.timeouts, serverName)
          ? settings.timeouts[serverName]
          : undefined
      }
      onSaveTimeout={
        settings.saveTimeout
          ? (seconds) => settings.saveTimeout!(serverName, seconds)
          : undefined
      }
      onBack={onBack}
    />
  );
}
