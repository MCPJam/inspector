/**
 * The Conformance page: picks the server, opens the setup steps and a
 * server's Settings, lists servers with runs, and hands each run to
 * `ConformanceContent`.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@mcpjam/design-system/button";
import type { ServerWithName } from "@/hooks/use-app-state";
import type {
  ConformanceSelection,
  ProtocolVersionPin,
} from "@/hooks/use-conformance-run";
import { useAppNavigate, useCurrentLocationParts } from "@/lib/app-navigation";
import { toast } from "@/lib/toast";
import type { ConformancePersistConfig } from "@/components/conformance/PersistConformanceRun";
import {
  ConformanceHeader,
  ConformancePreRun,
  ConformanceTabPanel,
  NO_SERVERS_MESSAGE,
  RUN_LABEL,
  type ConformanceView,
} from "./ConformancePageChrome";
import type { ConformanceRunListItem } from "./ConformanceHistory";
import {
  ConformanceContent,
  type ConformanceConnectServer,
} from "./ConformancePanel";
import { ConformanceServerList } from "./ConformanceServerList";
import { ConformanceSettings } from "./ConformanceSettings";
import { ConformanceSetup } from "./ConformanceSetup";

const LAST_SERVER_KEY = "mcpjam.conformance.lastServer.v1";

function readLastServer(): string | null {
  try {
    return window.localStorage.getItem(LAST_SERVER_KEY);
  } catch {
    return null;
  }
}

function rememberServer(name: string): void {
  try {
    window.localStorage.setItem(LAST_SERVER_KEY, name);
  } catch {
    // Unwritable storage: the page still picks the first connected server.
  }
}

export function ConformanceTab({
  server,
  persist,
  servers,
  onSelectServer,
  onConnectServer,
  onEditServer,
  history,
  serverDefaults,
  serverDefaultsLoaded = true,
  onSaveServerDefaults,
  lastRuns,
  onViewRun,
  projectServerNames,
  projectServersLoading,
}: {
  server?: ServerWithName | null;
  persist?: ConformancePersistConfig;
  /**
   * The project's servers, offered in the page's picker whether or not they
   * are connected: Run connects the selection first. Omit to hide the picker.
   */
  servers?: ServerWithName[];
  onSelectServer?: (name: string) => void;
  /** Connects a server in the background when Run is clicked on it. */
  onConnectServer?: ConformanceConnectServer;
  /** Opens a server's connection settings, after a failed connect. */
  onEditServer?: (name: string) => void;
  /** The History tab's content. Omit to hide the tab. */
  history?: ReactNode;
  /** Each server's saved default checks, by server name. */
  serverDefaults?: Record<string, ConformanceSelection>;
  /** False while `serverDefaults` is still loading: nothing runs on a guess. */
  serverDefaultsLoaded?: boolean;
  /** Saves a server's default checks. Omit to hide Settings. */
  onSaveServerDefaults?: (
    serverName: string,
    selection: ConformanceSelection,
  ) => Promise<void>;
  /** Each server's latest saved run, by server name, for the home list. */
  lastRuns?: Record<string, ConformanceRunListItem>;
  /** Opens a saved run's page. */
  onViewRun?: (runId: string) => void;
  /** Every server saved in the project, for the setup's picker. */
  projectServerNames?: readonly string[];
  /** The project's server list has not arrived yet. */
  projectServersLoading?: boolean;
}) {
  // The tab lives in the URL (`?view=history`, which a run's page links back
  // with), so a refresh, Back/Forward and the sidebar's plain `/conformance`
  // all land on the tab the address names. Both hooks work with or without a
  // router.
  const location = useCurrentLocationParts();
  const navigate = useAppNavigate();
  const view: ConformanceView =
    new URLSearchParams(location.search).get("view") === "history"
      ? "history"
      : "overview";
  const changeView = (next: ConformanceView) => {
    if (next === view) return;
    const params = new URLSearchParams(location.search);
    if (next === "history") params.set("view", "history");
    else params.delete("view");
    const query = params.toString();
    navigate(
      `${location.pathname}${query ? `?${query}` : ""}${location.hash}`,
      {
        replace: true,
      },
    );
  };
  const showHistory = history !== undefined;
  // Run opens the setup steps; Continue hands back the server and revision to
  // run, and the run view mounts fresh for them and starts. `id` keys that
  // mount, so a Continue on the server already shown still starts anew.
  const [setupOpen, setSetupOpen] = useState(false);
  const [start, setStart] = useState<{
    id: number;
    serverName: string;
    versionPin: ProtocolVersionPin;
    selection: ConformanceSelection;
  } | null>(null);
  // Which start already ran: switching servers and back must not run again.
  const startedIdRef = useRef(0);
  // The server whose Conformance Settings are open, over the run view.
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  // Defaults changed here while their save is in flight: Run again right
  // after a change in Settings must already run the new checks. Each entry
  // goes once its save settles, so the saved rows (a teammate's changes
  // included) are what the page reads after that.
  const [changedDefaults, setChangedDefaults] = useState<
    Record<string, ConformanceSelection>
  >({});
  const defaultsFor = (serverName: string) =>
    changedDefaults[serverName] ?? serverDefaults?.[serverName];
  const saveDefaults = onSaveServerDefaults
    ? (serverName: string, selection: ConformanceSelection) => {
        setChangedDefaults((prev) => ({ ...prev, [serverName]: selection }));
        const settle = () =>
          setChangedDefaults((prev) => {
            // A later change owns the entry now.
            if (prev[serverName] !== selection) return prev;
            const { [serverName]: _settled, ...rest } = prev;
            return rest;
          });
        return onSaveServerDefaults(serverName, selection).then(
          settle,
          (error: unknown) => {
            settle();
            throw error;
          },
        );
      }
    : undefined;
  // `?view=history` can outlive the History tab, e.g. a run link opened where
  // no history is passed. With the tabs hidden there would be no way back.
  const activeView: ConformanceView = showHistory ? view : "overview";

  // The app-wide selection can be empty, or a server this page does not
  // offer, and the picker then reads "Select a server" while the page still
  // names another one — two servers left people unsure which one ran. When
  // the selection is not one this page offers, pick for them: the server
  // last selected here, otherwise the first connected, otherwise the first.
  const selectionIsOffered = Boolean(
    server?.name && servers?.some((offered) => offered.name === server.name),
  );
  // A selection that is reconnecting is still the user's choice: switching
  // away would remount the run view and drop a run in flight on it.
  const selectionIsReconnecting = server?.connectionStatus === "connecting";
  useEffect(() => {
    if (!servers || servers.length === 0 || !onSelectServer) return;
    if (selectionIsOffered || selectionIsReconnecting) return;
    const remembered = readLastServer();
    const next =
      servers.find((offered) => offered.name === remembered) ??
      servers.find((offered) => offered.connectionStatus === "connected") ??
      servers[0]!;
    onSelectServer(next.name);
  }, [servers, onSelectServer, selectionIsOffered, selectionIsReconnecting]);
  useEffect(() => {
    if (selectionIsOffered && server?.name) rememberServer(server.name);
  }, [selectionIsOffered, server?.name]);

  const startRun = (
    serverName: string,
    versionPin: ProtocolVersionPin,
    selection: ConformanceSelection,
  ) => {
    onSelectServer?.(serverName);
    setStart((prev) => ({
      id: (prev?.id ?? 0) + 1,
      serverName,
      versionPin,
      selection,
    }));
    changeView("overview");
  };
  // Once servers have runs, the home lists them, each with a Run that goes
  // straight to a run with that server's default checks.
  const recentServers = (servers ?? []).flatMap((offered) => {
    const run = lastRuns?.[offered.name];
    return run ? [{ serverName: offered.name, run }] : [];
  });
  const home =
    recentServers.length > 0 && onViewRun ? (
      <ConformanceServerList
        runs={recentServers}
        onViewRun={onViewRun}
        disabled={!serverDefaultsLoaded || selectionIsReconnecting}
        onRun={(serverName) =>
          startRun(serverName, "auto", defaultsFor(serverName) ?? {})
        }
      />
    ) : undefined;
  // Run always opens the setup steps, even with no servers yet: the server
  // list may still be loading, and the steps say what is missing.
  const openSetup =
    servers && onSelectServer ? () => setSetupOpen(true) : undefined;

  const setup =
    setupOpen && servers && onSelectServer ? (
      <ConformanceSetup
        servers={servers}
        projectServerNames={projectServerNames}
        projectServersLoading={projectServersLoading}
        initialServerName={selectionIsOffered ? (server?.name ?? null) : null}
        initialVersionPin={start?.versionPin ?? "auto"}
        // Saved defaults win, as they do for Run again: they already hold the
        // last setup run's picks, plus any Settings change since. The last
        // run's picks only count for the server it ran on.
        initialSelection={
          start &&
          selectionIsOffered &&
          start.serverName === server?.name &&
          !defaultsFor(start.serverName)
            ? start.selection
            : undefined
        }
        defaultsFor={defaultsFor}
        defaultsLoaded={serverDefaultsLoaded}
        onConnectServer={onConnectServer}
        onEditServer={onEditServer}
        onCancel={() => setSetupOpen(false)}
        onRun={(serverName, versionPin, selection) => {
          setSetupOpen(false);
          startRun(serverName, versionPin, selection);
          // The checks picked here become the server's defaults: Settings
          // opens on them and the server list's Run reuses them. A failed
          // save leaves the old defaults; the run goes ahead either way.
          saveDefaults?.(serverName, selection).catch(() => {
            toast.error(
              "Could not save these checks as the server's defaults.",
            );
          });
        }}
      />
    ) : null;

  // In hosted mode `selectedMCPConfig` can arrive as a stub with falsy name
  // and/or missing config while the project is still hydrating — treat any
  // non-connected shape as "no server selected" so the panel never runs
  // against `undefined` (which would surface as "Hosted server not found
  // for 'undefined'" when Apps conformance calls the hosted resolver).
  if (!server || !server.name || server.name === "none" || !server.config) {
    if (setup) return setup;
    // Same pre-run page as with a server; running just asks for one first.
    const noServerRunButton = (
      <Button
        size="sm"
        onClick={openSetup ?? (() => toast.info(NO_SERVERS_MESSAGE))}
      >
        {RUN_LABEL}
      </Button>
    );
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <ConformanceHeader
          view={activeView}
          onViewChange={changeView}
          showHistory={showHistory}
        >
          {noServerRunButton}
        </ConformanceHeader>
        <ConformanceTabPanel view={activeView}>
          {activeView === "history" ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
              {history}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-8 pt-6 pb-8">
              {home ?? <ConformancePreRun runButton={noServerRunButton} />}
            </div>
          )}
        </ConformanceTabPanel>
      </div>
    );
  }

  // With a picker, only an offered server can start a run (connecting it
  // first when it is not connected): a selection the page no longer offers,
  // such as a removed server, must not. The run view stays mounted, so a run
  // in flight when the server drops or reconnects keeps its results and
  // still finishes persisting.
  const canRun = servers === undefined || selectionIsOffered;
  const startsHere = start?.serverName === server.name;
  const settingsServer = settingsFor ?? undefined;
  const content = (
    <ConformanceContent
      key={`${server.name}#${start?.id ?? 0}`}
      server={server}
      persist={persist}
      view={activeView}
      onViewChange={changeView}
      showHistory={showHistory}
      history={history}
      home={home}
      canRun={canRun}
      onConnectServer={onConnectServer}
      onEditServer={onEditServer}
      onRequestRun={openSetup}
      onOpenSettings={
        onSaveServerDefaults && selectionIsOffered
          ? () => setSettingsFor(server.name)
          : undefined
      }
      autoStart={Boolean(
        start && startsHere && startedIdRef.current !== start.id,
      )}
      onAutoStart={() => {
        if (start) startedIdRef.current = start.id;
      }}
      initialVersionPin={startsHere ? start?.versionPin : undefined}
      // Read when a run starts, so Run again runs the server's current
      // defaults, Settings changes included.
      selection={
        defaultsFor(server.name) ?? (startsHere ? start?.selection : undefined)
      }
    />
  );
  const settingsOpen = Boolean(settingsServer && onSaveServerDefaults);
  // The run view stays mounted, at the same place in the tree, under the
  // setup steps and Settings: remounting it would drop the results and cancel
  // a run still going.
  return (
    <>
      <div
        hidden={Boolean(setup) || settingsOpen}
        className={setup || settingsOpen ? "hidden" : "contents"}
      >
        {content}
      </div>
      {setup ??
        (settingsOpen && settingsServer && saveDefaults ? (
          <ConformanceSettings
            serverName={settingsServer}
            defaults={
              defaultsFor(settingsServer) ??
              // Nothing saved yet: the run's own picks.
              (start?.serverName === settingsServer
                ? start.selection
                : undefined)
            }
            onSave={(selection) => saveDefaults(settingsServer, selection)}
            onBack={() => setSettingsFor(null)}
          />
        ) : null)}
    </>
  );
}
