/**
 * The Conformance page: picks the server, opens the setup steps and a
 * server's Settings, lists servers with runs, and hands each run to
 * `ConformanceContent`.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@mcpjam/design-system/button";
import type { McpProtocolVersion } from "@mcpjam/sdk/browser";
import type { ServerWithName } from "@/hooks/use-app-state";
import type {
  ConformanceSelection,
  ProtocolVersionPin,
} from "@/hooks/use-conformance-run";
import { runnableSelection } from "@/hooks/conformance-suite-state";
import {
  CONFORMANCE_RUN_PARAM,
  useAppNavigate,
  useCurrentLocationParts,
} from "@/lib/app-navigation";
import { readLocalTimeout, saveLocalTimeout } from "./conformance-local-timeout";
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
import type { ConformanceDefaults } from "@/hooks/use-conformance-server-data";
import type { ConformanceProbes } from "@/hooks/use-conformance-probes";
import { ConformanceDefaultsError } from "./ConformanceDefaultsError";
import { ConformanceSettings } from "./ConformanceSettings";
import { ConformanceSetup } from "./ConformanceSetup";
import {
  probesAfterRun,
  useConformanceProbeStore,
} from "@/hooks/use-conformance-probes";

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
  serverInputs,
  onLoadServerDefaults,
  isSavedServer,
  serverTimeouts,
  onSaveServerTimeout,
  serverDefaultsLoaded = true,
  onSaveServerDefaults,
  lastRuns,
  onViewRun,
  projectServerNames,
  projectServersLoading,
  serverIcons,
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
  serverInputs?: Record<string, ConformanceProbes>;
  isSavedServer?: (name: string) => boolean;
  onLoadServerDefaults?: (serverName: string) => Promise<ConformanceDefaults>;
  serverTimeouts?: Record<string, number>;
  onSaveServerTimeout?: (serverName: string, seconds: number | null) => Promise<void>;
  /** False while `serverDefaults` is still loading: nothing runs on a guess. */
  serverDefaultsLoaded?: boolean;
  /** Saves a server's default checks. Omit to hide Settings. */
  onSaveServerDefaults?: (
    serverName: string,
    selection: ConformanceSelection,
    inputs?: ConformanceProbes,
  ) => Promise<void>;
  /** Each server's latest saved run, by server name, for the home list. */
  lastRuns?: Record<string, ConformanceRunListItem>;
  /** Opens a saved run's page. */
  onViewRun?: (runId: string) => void;
  /** Every server saved in the project, for the setup's picker. */
  projectServerNames?: readonly string[];
  /** The project's server list has not arrived yet. */
  projectServersLoading?: boolean;
  /** Each server's logo URL, by server name, where one is known. */
  serverIcons?: Record<string, string>;
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
    resolvedProtocolVersion?: McpProtocolVersion;
    selection: ConformanceSelection;
    inputs?: ConformanceProbes;
  } | null>(null);
  // Which start already ran: switching servers and back must not run again.
  const startedIdRef = useRef(0);
  // Bumped to send a finished run's view back to the page's home: its key
  // changes, so it mounts fresh, on the server list.
  const [homeVersion, setHomeVersion] = useState(0);
  // The server whose Conformance Settings are open, over the run view.
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  // The tools each server's checks may call: set in step 2, and
  // used by every later run of that server, Run again included.
  const { probesFor: sessionProbesFor, setProbes } = useConformanceProbeStore();
  const probesFor = (name: string) =>
    serverInputs && Object.hasOwn(serverInputs, name)
      ? serverInputs[name]!
      : sessionProbesFor(name);
  // Defaults changed here while their save is in flight: Run again right
  // after a change in Settings must already run the new checks. Each entry
  // goes once its save settles, so the saved rows (a teammate's changes
  // included) are what the page reads after that.
  const [changedDefaults, setChangedDefaults] = useState<
    Record<string, ConformanceSelection>
  >({});
  const savedTimeoutFor = (name: string) =>
    serverTimeouts && Object.hasOwn(serverTimeouts, name)
      ? serverTimeouts[name]
      : undefined;
  const [changedTimeouts, setChangedTimeouts] = useState<
    Record<string, number | null>
  >({});
  useEffect(() => {
    setChangedTimeouts((previous) => {
      const pending = Object.fromEntries(
        Object.entries(previous).filter(([name, seconds]) => {
          const saved = serverTimeouts && Object.hasOwn(serverTimeouts, name)
            ? serverTimeouts[name]
            : null;
          return seconds !== saved;
        }),
      );
      return Object.keys(pending).length === Object.keys(previous).length
        ? previous
        : pending;
    });
  }, [serverTimeouts]);
  const timeoutFor = (name: string) =>
    Object.hasOwn(changedTimeouts, name)
      ? changedTimeouts[name] ?? undefined
      : savedTimeoutFor(name) ?? (!persist ? readLocalTimeout(name) : undefined);
  const saveTimeout = async (name: string, seconds: number | null) => {
    if (onSaveServerTimeout) await onSaveServerTimeout(name, seconds);
    else if (!persist) saveLocalTimeout(name, seconds);
    else throw new Error("Server timeout settings are unavailable.");
    setChangedTimeouts((previous) => ({ ...previous, [name]: seconds }));
  };
  const defaultsFor = (serverName: string) =>
    Object.hasOwn(changedDefaults, serverName)
      ? changedDefaults[serverName]
      : serverDefaults && Object.hasOwn(serverDefaults, serverName)
        ? serverDefaults[serverName]
        : undefined;
  const saveDefaults = onSaveServerDefaults
    ? (
        serverName: string,
        selection: ConformanceSelection,
        inputs?: ConformanceProbes,
      ) => {
        setChangedDefaults((prev) => ({ ...prev, [serverName]: selection }));
        const settle = () =>
          setChangedDefaults((prev) => {
            // A later change owns the entry now.
            if (prev[serverName] !== selection) return prev;
            const { [serverName]: _settled, ...rest } = prev;
            return rest;
          });
        return (
          isSavedServer && !isSavedServer(serverName)
            ? Promise.resolve()
            : onSaveServerDefaults(serverName, selection, inputs)
        ).then(settle, (error: unknown) => {
          settle();
          throw error;
        });
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

  const beginRun = (
    serverName: string,
    versionPin: ProtocolVersionPin,
    selection: ConformanceSelection,
    inputs?: ConformanceProbes,
    resolvedProtocolVersion?: McpProtocolVersion,
  ) => {
    onSelectServer?.(serverName);
    setStart((prev) => ({
      id: (prev?.id ?? 0) + 1,
      serverName,
      versionPin,
      resolvedProtocolVersion,
      selection,
      inputs,
    }));
  };
  const startRun = (
    serverName: string,
    versionPin: ProtocolVersionPin,
    selection: ConformanceSelection,
    inputs?: ConformanceProbes,
    resolvedProtocolVersion?: McpProtocolVersion,
  ) => {
    beginRun(serverName, versionPin, selection, inputs, resolvedProtocolVersion);
    changeView("overview");
  };
  const [loadingDefaults, setLoadingDefaults] = useState(false);
  const [failedRequest, setFailedRequest] = useState<{
    name: string;
    pin?: ProtocolVersionPin;
  } | null>(null);
  const readDefaults = (name: string): Promise<ConformanceDefaults> =>
    onLoadServerDefaults &&
    !(isSavedServer && !isSavedServer(name) && !projectServersLoading)
      ? onLoadServerDefaults(name)
      : Promise.resolve({
          selection:
            defaultsFor(name) ??
            (start?.serverName === name ? start.selection : {}),
          inputs: probesFor(name),
        });
  const mounted = useRef(true);
  const requestId = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const requestDefaults = async (
    name: string,
    pin?: ProtocolVersionPin,
    arriving = false,
  ) => {
    const id = ++requestId.current;
    setLoadingDefaults(true);
    setFailedRequest(null);
    try {
      const defaults = await readDefaults(name);
      if (!mounted.current || id !== requestId.current) return;
      if (pin)
        (arriving ? beginRun : startRun)(
          name,
          pin,
          defaults.selection,
          defaults.inputs,
        );
      else setSettingsFor(name);
    } catch {
      if (mounted.current && id === requestId.current)
        setFailedRequest({ name, pin });
    } finally {
      if (mounted.current && id === requestId.current)
        setLoadingDefaults(false);
    }
  };
  // A saved run's Run again lands here with `?run=<server>`: start that
  // server with its default checks, the way the server list's Run does. The
  // key is dropped first, so a refresh or Back does not run it again.
  const runRequest = new URLSearchParams(location.search).get(
    CONFORMANCE_RUN_PARAM,
  );
  const handledRunRequest = useRef<string | null>(null);
  const startRequestedRun = useRef(() => {});
  useEffect(() => {
    startRequestedRun.current = () => {
      if (!runRequest) return;
      // One navigation, to the Overview the run shows on, without the key.
      // `changeView` would rebuild the URL from this render's search and
      // write the key back, starting the run a second time.
      const params = new URLSearchParams(location.search);
      params.delete(CONFORMANCE_RUN_PARAM);
      params.delete("view");
      const query = params.toString();
      navigate(
        `${location.pathname}${query ? `?${query}` : ""}${location.hash}`,
        { replace: true },
      );
      if (servers?.some((offered) => offered.name === runRequest)) {
        void requestDefaults(runRequest, "auto", true);
      } else {
        toast.info(`${runRequest} is not one of this project's servers.`);
      }
    };
  });
  useEffect(() => {
    // Wait for what the run reads: the servers and their default checks.
    if (!runRequest || !servers || projectServersLoading) return;
    if (!serverDefaultsLoaded) return;
    if (handledRunRequest.current === location.search) return;
    handledRunRequest.current = location.search;
    startRequestedRun.current();
  }, [
    runRequest,
    servers,
    projectServersLoading,
    serverDefaultsLoaded,
    location.search,
  ]);
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
        serverIcons={serverIcons}
        onViewRun={onViewRun}
        disabled={
          !serverDefaultsLoaded || loadingDefaults || selectionIsReconnecting
        }
        disabledServerName={failedRequest?.name}
        onRun={(serverName) =>
          onLoadServerDefaults
            ? void requestDefaults(serverName, "auto")
            : startRun(serverName, "auto", defaultsFor(serverName) ?? {})
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
        timeoutFor={timeoutFor}
        onSaveTimeout={saveTimeout}
        defaultsFor={defaultsFor}
        defaultsLoaded={serverDefaultsLoaded}
        onLoadDefaults={onLoadServerDefaults ? readDefaults : undefined}
        onConnectServer={onConnectServer}
        onEditServer={onEditServer}
        probesFor={probesFor}
        onCancel={() => setSetupOpen(false)}
        onRun={(
          serverName,
          versionPin,
          selection,
          probes,
          resolvedProtocolVersion,
        ) => {
          const effectiveVersion = resolvedProtocolVersion ?? versionPin;
          setSetupOpen(false);
          const runnable = runnableSelection(selection, effectiveVersion);
          const savedInputs = probesAfterRun(
            probesFor(serverName),
            probes,
            runnable,
            effectiveVersion,
          );
          setProbes(serverName, savedInputs);
          startRun(serverName, versionPin, selection, probes, resolvedProtocolVersion);
          // The checks picked here become the server's defaults: Settings
          // opens on them and the server list's Run reuses them. A failed
          // save leaves the old defaults; the run goes ahead either way.
          saveDefaults?.(serverName, selection, savedInputs).catch(() => {
            toast.error(
              "Could not save these checks as the server's defaults. Change them in Settings to try again.",
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
      key={`${server.name}#${start?.id ?? 0}#${homeVersion}`}
      server={server}
      persist={persist}
      view={activeView}
      onViewChange={changeView}
      onShowHome={() => {
        setHomeVersion((version) => version + 1);
        changeView("overview");
      }}
      serverIconUrl={serverIcons?.[server.name]}
      showHistory={showHistory}
      history={history}
      home={home}
      canRun={canRun && !loadingDefaults}
      runDisabled={loadingDefaults || failedRequest?.name === server.name}
      onConnectServer={onConnectServer}
      onEditServer={onEditServer}
      onRequestRun={openSetup}
      onOpenSettings={
        onSaveServerDefaults &&
        selectionIsOffered &&
        (!isSavedServer || isSavedServer(server.name))
          ? () =>
              onLoadServerDefaults
                ? void requestDefaults(server.name)
                : setSettingsFor(server.name)
          : undefined
      }
      // Settings starts from the saved defaults: opened before they load, it
      // would start from "everything" and a change would save over them.
      settingsLoading={!serverDefaultsLoaded || loadingDefaults}
      onRunAgain={
        onLoadServerDefaults
          ? (pin) => void requestDefaults(server.name, pin)
          : undefined
      }
      autoStart={Boolean(
        start && startsHere && startedIdRef.current !== start.id,
      )}
      onAutoStart={() => {
        if (start) startedIdRef.current = start.id;
      }}
      initialVersionPin={startsHere ? start?.versionPin : undefined}
      initialResolvedProtocolVersion={
        startsHere ? start?.resolvedProtocolVersion : undefined
      }
      // Read when a run starts, so Run again runs the server's current
      // defaults, Settings changes included.
      selection={
        startsHere && startedIdRef.current !== start?.id
          ? start?.selection
          : (defaultsFor(server.name) ??
            (startsHere ? start?.selection : undefined))
      }
      probes={
        startsHere && startedIdRef.current !== start?.id
          ? (start?.inputs ?? probesFor(server.name))
          : probesFor(server.name)
      }
      runTimeoutSeconds={timeoutFor(server.name)}
    />
  );
  // Also closed while the defaults reload, e.g. after a project switch: it
  // comes back, started fresh, once they have.
  const settingsOpen = Boolean(
    settingsServer && onSaveServerDefaults && serverDefaultsLoaded,
  );
  // The run view stays mounted, at the same place in the tree, under the
  // setup steps and Settings: remounting it would drop the results and cancel
  // a run still going.
  return (
    <>
      {failedRequest ? (
        <ConformanceDefaultsError
          onRetry={() =>
            void requestDefaults(failedRequest.name, failedRequest.pin)
          }
        />
      ) : null}
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
            server={servers?.find((offered) => offered.name === settingsServer)}
            inputs={probesFor(settingsServer)}
            onConnectServer={onConnectServer}
            onEditServer={onEditServer}
            defaults={
              defaultsFor(settingsServer) ??
              // Nothing saved yet: the run's own picks.
              (start?.serverName === settingsServer
                ? start.selection
                : undefined)
            }
            onSave={(selection, inputs) =>
              saveDefaults(settingsServer, selection, inputs)
            }
            onBack={() => setSettingsFor(null)}
          />
        ) : null)}
    </>
  );
}
