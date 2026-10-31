import { useEffect, useRef, useState, useMemo, type ReactNode } from "react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { Button } from "@mcpjam/design-system/button";
import { DirectoryReadinessSection } from "@/components/conformance/directory-readiness/DirectoryReadinessSection";
import { OAuthPopupBlockedDialog } from "@/components/conformance/OAuthPopupBlockedDialog";
import { Loader2, AlertTriangle, Settings, Share2 } from "lucide-react";
import type { ServerWithName } from "@/hooks/use-app-state";
// Import from the browser-safe SDK entry — the top-level `@mcpjam/sdk` pulls
// Node-only transitive deps (MCP client SDK uses `node:stream`, etc.) which
// break the Vite browser bundle.
import {
  isAuthorizationRequiredCheck,
  type ConformanceScore,
} from "@mcpjam/sdk/browser";
import {
  OverallScoreCard,
  SUITE_COPY,
  SuiteRow,
  VerdictBadge,
} from "./conformance-ui";
import {
  CatalogList,
  CheckRow,
  OAuthStepRow,
  pendingIdSet,
  type CatalogEntry,
} from "./ConformanceCheckRows";
import {
  APPS_CATALOG,
  OAUTH_CATALOG,
  TASKS_CATALOG,
  protocolCatalog,
} from "./conformance-catalogs";
import {
  ConformanceConnectError,
  ConformanceHeader,
  ConformancePreRun,
  ConformanceTabPanel,
  NO_SERVERS_MESSAGE,
  RUN_LABEL,
  type ConformanceView,
} from "./ConformancePageChrome";
import { toast } from "@/lib/toast";
import {
  useConformanceRun,
  type ConformanceSelection,
  type ProtocolVersionPin,
  type SuiteState,
} from "@/hooks/use-conformance-run";
import {
  ConformanceRunShareButton,
  detailDateFormat,
} from "./ConformanceHistory";
import {
  PersistConformanceRun,
  type ConformancePersistConfig,
} from "@/components/conformance/PersistConformanceRun";

/** What a background connect from Run came back with. */
export type ConformanceConnectOutcome = "ready" | "reauth" | "failed";

/**
 * Connects a server in the background. `signIn` lets the connect open the
 * server's sign-in, for a server whose last connect needed one.
 */
export type ConformanceConnectServer = (
  name: string,
  options?: { signIn?: boolean },
) => Promise<ConformanceConnectOutcome>;

function SuiteBadge({ state }: { state: SuiteState }) {
  if (state.status === "running") {
    return <VerdictBadge label="RUNNING" tone="neutral" spinning />;
  }
  if (state.status === "unavailable") {
    return (
      <VerdictBadge
        label={state.notSelected ? "NOT SELECTED" : "NOT APPLICABLE"}
        tone="neutral"
      />
    );
  }
  if (state.status === "error") {
    return <VerdictBadge label="ERROR" tone="danger" />;
  }
  if (state.status === "done") {
    if (state.verdict === "failed") {
      return <VerdictBadge label="FAILED" tone="danger" />;
    }
    if (state.verdict === "incomplete") {
      return <VerdictBadge label="INCOMPLETE" tone="warning" />;
    }
    return <VerdictBadge label="PASSED" tone="success" />;
  }
  return null;
}

function SuiteSection({
  title,
  description,
  state,
  catalog,
  catalogNote,
  hasResult,
  score,
  children,
}: {
  title: string;
  /** What the suite covers; replaced by the reason when it cannot run. */
  description: string;
  state: SuiteState;
  /** What this suite runs, shown until a real result replaces it. */
  catalog: CatalogEntry[];
  catalogNote?: string;
  hasResult: boolean;
  /** This suite's score, shown at the row's right edge. */
  score?: ConformanceScore;
  children?: React.ReactNode;
}) {
  // `null` follows the suite: a finished suite that did not pass opens itself
  // so the failures are visible; a passing or running one stays shut. OAuth
  // waiting on the browser opens too, so its prompt is not hidden. Clicking
  // pins an explicit choice until the next run remounts. A suite that does not
  // apply stays shut but still opens on click, to its list of checks.
  const [override, setOverride] = useState<boolean | null>(null);
  const running = state.status === "running";
  const unavailable = state.status === "unavailable";
  const waitingForAuth = Boolean(
    (state as { waitingForAuth?: boolean }).waitingForAuth,
  );
  const skipped = Boolean((state as { skipped?: boolean }).skipped);
  const autoOpen =
    waitingForAuth ||
    state.status === "error" ||
    (state.status === "done" && state.verdict !== "passed");
  const expanded = override ?? autoOpen;

  return (
    <SuiteRow
      title={title}
      subtitle={
        unavailable && state.unavailableReason
          ? state.unavailableReason
          : description
      }
      badge={<SuiteBadge state={state} />}
      score={
        score && score.score !== null
          ? {
              score: score.score,
              passed: score.passed,
              applicable: score.applicable,
            }
          : null
      }
      expanded={expanded}
      collapsible
      onToggle={() => setOverride(!expanded)}
      notice={
        state.status === "error" && state.error ? (
          <div className="px-4 pb-3 pl-11">
            <div className="rounded-sm border border-red-500/20 bg-red-500/5 px-2 py-1.5 text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap break-words">
              {state.error}
            </div>
          </div>
        ) : null
      }
    >
      {unavailable ? (
        <CatalogList
          catalog={catalog}
          note={
            skipped || state.notSelected
              ? ". Not run."
              : ". None apply to this server."
          }
        />
      ) : hasResult ? (
        children
      ) : running ? (
        // Mid-run with nothing to show yet: the catalog would read as
        // "not run yet", which is exactly wrong while the run is live.
        <div className="flex items-center gap-2 py-3 pl-7 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Running {catalog.length} checks...
        </div>
      ) : (
        <CatalogList
          catalog={catalog}
          note={`. Not run yet.${catalogNote ? ` ${catalogNote}` : ""}`}
        />
      )}
    </SuiteRow>
  );
}

export function ConformanceContent({
  server,
  persist,
  view,
  onViewChange,
  showHistory,
  history,
  home,
  canRun,
  onConnectServer,
  onEditServer,
  onRequestRun,
  onOpenSettings,
  settingsLoading = false,
  autoStart = false,
  onAutoStart,
  initialVersionPin,
  selection,
}: {
  server: ServerWithName;
  persist?: ConformancePersistConfig;
  view: ConformanceView;
  onViewChange: (view: ConformanceView) => void;
  showHistory: boolean;
  history?: ReactNode;
  /** Shown before the first run instead of the first-run prompt. */
  home?: ReactNode;
  /** False when the selection is not one of the page's servers. */
  canRun: boolean;
  onConnectServer?: ConformanceConnectServer;
  onEditServer?: (name: string) => void;
  /** Set when Run opens the setup steps instead of running here. */
  onRequestRun?: () => void;
  /** Opens this server's Conformance Settings. */
  onOpenSettings?: () => void;
  /** The saved defaults Settings edits have not loaded yet. */
  settingsLoading?: boolean;
  /** Run once on mount: the setup steps just chose this server. */
  autoStart?: boolean;
  onAutoStart?: () => void;
  initialVersionPin?: ProtocolVersionPin;
  /** What to run, as picked in the setup steps. */
  selection?: ConformanceSelection;
}) {
  // Run state, per-suite scores and the pooled headline all live in the shared
  // hook — score.mcpjam.com runs the same four suites and must pool them the
  // same way. Rendering stays here.
  const snapshot = useConformanceRun({
    server,
    initialVersionPin,
    selection,
  });
  const {
    protocol,
    apps,
    tasks,
    oauth,
    versionPin,
    runVersion,
    runAll,
    protocolScore,
    appsScore,
    tasksScore,
    oauthScore,
    pooledScore,
    oauthNotScored,
    isRunning,
    openAuthorizationWindow,
    skipOAuth,
  } = snapshot;

  const protocolChecks = useMemo(
    () => protocolCatalog(versionPin),
    [versionPin],
  );
  const protocolPendingIds = pendingIdSet(protocol.result);
  const tasksPendingIds = pendingIdSet(tasks.result);
  // Checks the server refused for credentials. They could not run, so each
  // suite reads INCOMPLETE; one notice above the suites names the next step
  // instead of leaving a 401 in every section.
  const waitingOnAuthorization = [protocol, apps, tasks].reduce(
    (count, suite) =>
      count +
      (suite.result?.checks.filter(isAuthorizationRequiredCheck).length ?? 0),
    0,
  );
  // The verdict compares this to the score's `couldNotRun`, which leaves out
  // unscored checks, so it counts only the scored refusals. Otherwise the
  // headline could blame sign-in for checks that stopped for another reason.
  const scoredRefusals = (
    checks: Array<{ id: string; details?: unknown }> | undefined,
    pendingIds: Set<string>,
  ) =>
    checks?.filter(
      (check) =>
        isAuthorizationRequiredCheck(check) && !pendingIds.has(check.id),
    ).length ?? 0;
  const blockedBySignIn =
    scoredRefusals(protocol.result?.checks, protocolPendingIds) +
    scoredRefusals(apps.result?.checks, new Set()) +
    scoredRefusals(tasks.result?.checks, tasksPendingIds);

  // The page opens on the "run your first check" state and only swaps to the
  // suites once a run has begun. Keyed by server, so a server switch resets it.
  const [started, setStarted] = useState(false);
  // When the shown run started, for the run header.
  const [startedAt, setStartedAt] = useState<number | null>(null);
  // The run `PersistConformanceRun` saved last, which Share shares.
  const [savedRunId, setSavedRunId] = useState<string | null>(null);
  // Run on a server that is not connected connects it first, in the
  // background. The run starts from the effect below, once the connected
  // server has rendered: the suites read the server from this render.
  const [connect, setConnect] = useState<
    | { status: "idle" | "connecting" | "ready" }
    | { status: "failed"; needsSignIn: boolean }
  >({ status: "idle" });
  const connectAndRun = async (signIn = false) => {
    if (!onConnectServer) return;
    setConnect({ status: "connecting" });
    let outcome: ConformanceConnectOutcome;
    try {
      outcome = await onConnectServer(server.name, { signIn });
    } catch {
      outcome = "failed";
    }
    setConnect(
      outcome === "ready"
        ? { status: "ready" }
        : { status: "failed", needsSignIn: outcome === "reauth" },
    );
  };
  const isConnected = server.connectionStatus === "connected";
  // A server reconnected another way (Edit connection, the server menu) ends
  // the failure, so a later disconnect does not bring the old alert back.
  useEffect(() => {
    if (connect.status === "failed" && isConnected) {
      setConnect({ status: "idle" });
    }
  }, [connect.status, isConnected]);
  useEffect(() => {
    if (connect.status !== "ready" || !isConnected) return;
    setConnect({ status: "idle" });
    setStarted(true);
    setStartedAt(Date.now());
    runAll();
  }, [connect.status, isConnected, runAll]);
  const handleRun = () => {
    if (!canRun) {
      toast.info(NO_SERVERS_MESSAGE);
      return;
    }
    if (!isConnected && onConnectServer) {
      void connectAndRun();
      return;
    }
    setConnect({ status: "idle" });
    setStarted(true);
    setStartedAt(Date.now());
    // Run sits in the header on both tabs. From History, the new run would
    // otherwise go unseen until the user switched back by hand.
    onViewChange("overview");
    runAll();
  };
  // Once per mount: the key changes for each start from the setup steps or
  // the server list. Deferred so a mount React undoes at once (StrictMode
  // mounts twice in development) starts nothing: its unmount would cancel the
  // run and reset the suites, leaving a started page with every suite idle.
  // The latest start, so the effect below keys on `autoStart` alone.
  const autoStartRun = useRef(() => {});
  useEffect(() => {
    autoStartRun.current = () => {
      onAutoStart?.();
      handleRun();
    };
  });
  useEffect(() => {
    if (!autoStart) return;
    const timer = setTimeout(() => autoStartRun.current());
    return () => clearTimeout(timer);
  }, [autoStart]);
  const isConnecting =
    connect.status === "connecting" || connect.status === "ready";
  const hasStarted =
    started ||
    isRunning ||
    [protocol, apps, tasks, oauth].some(
      (suite) => suite.status === "done" || suite.status === "error",
    );

  // The Overview of a started run shows the run's own header, not the tabs.
  const liveRun = hasStarted && view === "overview";

  // DELIBERATELY OUTSIDE `runAll` AND THE POOLED SCORE. A hosted readiness
  // run takes minutes, so joining the shared `isRunning` would hold the Run
  // button and the protocol-version select hostage for its duration — and
  // readiness produces lanes and coverage rather than passed/failed checks,
  // so there is no number to pool. Each section owns its own run control and
  // recovers a run still in flight when it mounts, so it shows before the
  // suites have run, too.
  //
  // Behind `mcpjam-directory-readiness` again while directory submissions are
  // a later phase: the page ships protocol conformance first. `=== true`, so
  // a missing flag (or one PostHog has not hydrated yet) keeps them hidden
  // rather than flashing them for users the flag excludes.
  const directoryReadinessEnabled =
    useFeatureFlagEnabled("mcpjam-directory-readiness") === true;
  const readiness = directoryReadinessEnabled ? (
    <div className="space-y-4">
      <DirectoryReadinessSection publisher="claude" server={server} />
      <DirectoryReadinessSection publisher="openai" server={server} />
      <DirectoryReadinessSection publisher="muse" server={server} />
    </div>
  ) : null;

  const runButton = (
    <Button
      size="sm"
      onClick={onRequestRun ?? handleRun}
      disabled={isRunning || isConnecting}
    >
      {isRunning || isConnecting ? (
        <>
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          {isConnecting ? "Connecting..." : "Running..."}
        </>
      ) : (
        RUN_LABEL
      )}
    </Button>
  );
  // `!isConnected` hides the alert in the render before the effect above
  // resets the failure.
  const connectError =
    connect.status === "failed" && !isConnected ? (
      <ConformanceConnectError
        server={server}
        needsSignIn={connect.needsSignIn}
        onRetry={() => void connectAndRun(connect.needsSignIn)}
        onEdit={onEditServer ? () => onEditServer(server.name) : undefined}
      />
    ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {persist ? (
        <PersistConformanceRun
          persist={persist}
          server={server}
          snapshot={snapshot}
          onSavedRun={setSavedRunId}
        />
      ) : null}
      {liveRun ? (
        // A run on screen reads like its saved page: where it sits in
        // History, what can be done with it, and when it ran.
        <div className="flex shrink-0 flex-col gap-2 border-b border-border px-8 pt-5 pb-4">
          <div className="flex items-center gap-2 text-sm">
            {showHistory ? (
              <button
                type="button"
                className="font-medium tracking-tight text-muted-foreground hover:text-foreground"
                onClick={() => onViewChange("history")}
              >
                Conformance History
              </button>
            ) : (
              <span className="font-medium tracking-tight text-muted-foreground">
                Conformance
              </span>
            )}
            <span className="text-muted-foreground/70">/</span>
            <span className="truncate font-semibold">{server.name}</span>
            <div className="ml-auto flex items-center gap-2">
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
              {persist ? (
                savedRunId ? (
                  <ConformanceRunShareButton
                    runId={savedRunId}
                    finished={!isRunning}
                    sharingEnabled={false}
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
                onClick={handleRun}
                disabled={isRunning || isConnecting}
              >
                {isRunning || isConnecting ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    {isConnecting ? "Connecting..." : "Running..."}
                  </>
                ) : (
                  "Run again"
                )}
              </Button>
            </div>
          </div>
          {startedAt ? (
            <p className="text-sm text-muted-foreground">
              {detailDateFormat.format(startedAt)} · UI
            </p>
          ) : null}
        </div>
      ) : (
        <ConformanceHeader
          view={view}
          onViewChange={onViewChange}
          showHistory={showHistory}
        >
          {runButton}
        </ConformanceHeader>
      )}

      <ConformanceTabPanel view={view}>
        {view === "history" ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
            {history}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-8 pt-6 pb-8">
            {connectError}
            {!hasStarted ? (
              (home ?? <ConformancePreRun runButton={runButton} />)
            ) : (
              <div>
                <OverallScoreCard
                  score={pooledScore}
                  serverName={server.name}
                  version={
                    pooledScore?.protocolVersion ??
                    (versionPin === "auto" ? "Auto" : versionPin)
                  }
                  isRunning={isRunning}
                  oauthNotScored={oauthNotScored}
                  blockedBySignIn={blockedBySignIn}
                />

                {waitingOnAuthorization > 0 && (
                  <div className="mt-3 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs leading-relaxed">
                    This server requires sign-in, and this run had no valid
                    session, so the checks that need it could not run.
                    Reconnect the server with OAuth from the server menu, or
                    update its access token, then run again.
                  </div>
                )}

                <div className="mt-3 overflow-hidden rounded-lg border border-border bg-popover">
                  <SuiteSection
                    key={`${runVersion}-protocol`}
                    title={SUITE_COPY.protocol.title}
                    description={SUITE_COPY.protocol.description}
                    state={protocol}
                    score={protocolScore}
                    catalog={protocolChecks}
                    catalogNote={
                      versionPin === "auto"
                        ? "The negotiated version decides which era's checks run."
                        : undefined
                    }
                    hasResult={Boolean(protocol.result)}
                  >
                    {protocol.result ? (
                      <div>
                        {(protocol.result.readiness ?? []).length > 0 && (
                          <div className="my-2 space-y-1 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2">
                            {(protocol.result.readiness ?? []).map(
                              (warning) => (
                                <div
                                  key={warning.id}
                                  className="flex items-start gap-1.5 text-[11px]"
                                >
                                  <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0 text-amber-500" />
                                  <span className="min-w-0">
                                    <span className="font-medium">
                                      {warning.title}
                                    </span>{" "}
                                    <span className="text-muted-foreground">
                                      ({warning.specStrength})
                                    </span>{" "}
                                    — {warning.message}
                                  </span>
                                </div>
                              ),
                            )}
                          </div>
                        )}
                        {protocol.result.checks.map((check) => (
                          <CheckRow
                            key={`${runVersion}-${check.id}`}
                            check={check}
                            pending={protocolPendingIds.has(check.id)}
                          />
                        ))}
                      </div>
                    ) : null}
                  </SuiteSection>

                  <SuiteSection
                    key={`${runVersion}-apps`}
                    title={SUITE_COPY.apps.title}
                    description={SUITE_COPY.apps.description}
                    state={apps}
                    score={appsScore}
                    catalog={APPS_CATALOG}
                    hasResult={Boolean(apps.result)}
                  >
                    {apps.result ? (
                      <div>
                        {apps.result.checks.map((check) => (
                          <CheckRow
                            key={`${runVersion}-${check.id}`}
                            check={check}
                          />
                        ))}
                      </div>
                    ) : null}
                  </SuiteSection>

                  <SuiteSection
                    key={`${runVersion}-tasks`}
                    title={SUITE_COPY.tasks.title}
                    description={SUITE_COPY.tasks.description}
                    state={tasks}
                    score={tasksScore}
                    catalog={TASKS_CATALOG}
                    hasResult={Boolean(tasks.result)}
                  >
                    {tasks.result ? (
                      <div>
                        {tasks.result.checks.map((check) => (
                          <CheckRow
                            key={`${runVersion}-${check.id}`}
                            check={check}
                            pending={tasksPendingIds.has(check.id)}
                          />
                        ))}
                      </div>
                    ) : null}
                  </SuiteSection>

                  <SuiteSection
                    key={`${runVersion}-oauth`}
                    title={SUITE_COPY.oauth.title}
                    description={SUITE_COPY.oauth.description}
                    state={oauth}
                    score={oauthScore}
                    catalog={OAUTH_CATALOG}
                    catalogNote="The authorization flow steps are recorded as the run proceeds."
                    hasResult={
                      Boolean(oauth.result) || Boolean(oauth.waitingForAuth)
                    }
                  >
                    {oauth.waitingForAuth ? (
                      // Always offer a way forward: a blocked popup used to
                      // leave this spinner alone until the session expired.
                      <div className="space-y-2 px-1 py-3 text-xs">
                        <div className="flex items-center gap-2 text-muted-foreground">
                          {oauth.popupBlocked ? (
                            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                          ) : (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          )}
                          {oauth.popupBlocked
                            ? "Your browser blocked the sign-in window. Allow pop-ups for this site, or open the sign-in page."
                            : "Waiting for browser authorization..."}
                        </div>
                        <div className="flex gap-2">
                          {oauth.authorizationUrl ? (
                            <Button
                              size="sm"
                              variant={
                                oauth.popupBlocked ? "default" : "outline"
                              }
                              onClick={openAuthorizationWindow}
                            >
                              Open sign-in page
                            </Button>
                          ) : null}
                          <Button size="sm" variant="ghost" onClick={skipOAuth}>
                            Skip OAuth
                          </Button>
                        </div>
                      </div>
                    ) : oauth.result ? (
                      <div>
                        {oauth.result.steps.map((step) => (
                          <OAuthStepRow
                            key={`${runVersion}-${step.step}`}
                            step={step}
                          />
                        ))}
                      </div>
                    ) : null}
                  </SuiteSection>
                </div>
              </div>
            )}

            {/* The same slot before and after the first run, so starting it
                keeps the sections mounted and their selections intact. */}
            {readiness ? <div className="mt-6">{readiness}</div> : null}
          </div>
        )}
      </ConformanceTabPanel>
      <OAuthPopupBlockedDialog
        open={Boolean(oauth.waitingForAuth && oauth.popupBlocked)}
        serverName={server.name}
        onOpen={openAuthorizationWindow}
        onSkip={skipOAuth}
      />
    </div>
  );
}
