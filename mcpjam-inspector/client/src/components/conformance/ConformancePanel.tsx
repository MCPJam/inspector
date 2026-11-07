import { useEffect, useRef, useState, useMemo, type ReactNode } from "react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { Button } from "@mcpjam/design-system/button";
import { DirectoryReadinessSection } from "@/components/conformance/directory-readiness/DirectoryReadinessSection";
import { OAuthPopupBlockedDialog } from "@/components/conformance/OAuthPopupBlockedDialog";
import { ConformanceAdvice, suiteAdviceGroups } from "./ConformanceAdvice";
import { ConformanceVersionNotice } from "./ConformanceVersionNotice";
import { liveConformanceVersionRefusal } from "./conformance-version-refusal";
import { Loader2, AlertTriangle } from "lucide-react";
import { UncheckedAdvice } from "@/components/conformance/UncheckedAdvice";
import type { ServerWithName } from "@/hooks/use-app-state";
// Import from the browser-safe SDK entry — the top-level `@mcpjam/sdk` pulls
// Node-only transitive deps (MCP client SDK uses `node:stream`, etc.) which
// break the Vite browser bundle.
import {
  isAuthorizationRequiredCheck,
  isTimedOutCheck,
  type ConformanceScore,
  type McpProtocolVersion,
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
import type { ConformanceProbes } from "@/hooks/use-conformance-probes";
import {
  useConformanceRun,
  type ConformanceSelection,
  type ProtocolVersionPin,
  type SuiteState,
} from "@/hooks/use-conformance-run";
import { ConformanceRunHeader } from "./ConformanceRunHeader";
import {
  PersistConformanceRun,
  type ConformancePersistConfig,
} from "@/components/conformance/PersistConformanceRun";

import type { ConformanceConnectServer } from "./connect-conformance-server";
export type {
  ConformanceConnectOutcome,
  ConformanceConnectServer,
} from "./connect-conformance-server";

function SuiteBadge({
  state,
  notApplicable = false,
}: {
  state: SuiteState;
  notApplicable?: boolean;
}) {
  if (state.status === "running") {
    return <VerdictBadge label="RUNNING" tone="neutral" spinning />;
  }
  if (state.status === "unavailable" || notApplicable) {
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
  // Without an explicit choice, show failures and pending OAuth prompts.
  // Clicks pin the choice until the next run remounts.
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
      badge={
        <SuiteBadge
          state={state}
          notApplicable={
            state.status === "done" &&
            state.verdict === "passed" &&
            score?.applicable === 0 &&
            score.notApplicable > 0
          }
        />
      }
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
            <div className="rounded-sm border border-red-500/20 bg-red-500/5 px-2 py-1.5 text-sm text-red-600 dark:text-red-400 whitespace-pre-wrap break-words">
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
        <div className="flex items-center gap-2 py-3 pl-7 text-sm text-muted-foreground">
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
  runDisabled = false,
  onConnectServer,
  onEditServer,
  onRequestRun,
  onRunAgain,
  onOpenSettings,
  settingsLoading = false,
  onShowHome,
  serverIconUrl,
  autoStart = false,
  onAutoStart,
  initialVersionPin,
  initialResolvedProtocolVersion,
  selection,
  runTimeoutSeconds,
  probes,
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
  /** Defaults must load successfully before a new run can start. */
  runDisabled?: boolean;
  onConnectServer?: ConformanceConnectServer;
  onEditServer?: (name: string) => void;
  /** Set when Run opens the setup steps instead of running here. */
  onRequestRun?: () => void;
  onRunAgain?: (pin: ProtocolVersionPin) => void;
  /** Opens this server's Conformance Settings. */
  onOpenSettings?: () => void;
  /** The server's logo, when the project or the server provides one. */
  serverIconUrl?: string;
  /** Return to the server list; the completed run remains in History. */
  onShowHome: () => void;
  /** The saved defaults Settings edits have not loaded yet. */
  settingsLoading?: boolean;
  /** Run once on mount: the setup steps just chose this server. */
  autoStart?: boolean;
  onAutoStart?: () => void;
  initialVersionPin?: ProtocolVersionPin;
  initialResolvedProtocolVersion?: McpProtocolVersion;
  /** What to run, as picked in the setup steps. */
  selection?: ConformanceSelection;
  runTimeoutSeconds?: number;
  /** The tools the checks that must call one may use. */
  probes?: ConformanceProbes;
}) {
  // The public score page shares this run state and score calculation.
  const snapshot = useConformanceRun({
    server,
    initialVersionPin,
    initialResolvedProtocolVersion,
    selection,
    runTimeoutSeconds,
    probes,
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
    oauthUnscored,
    isRunning,
    openAuthorizationWindow,
    skipOAuth,
  } = snapshot;

  const protocolChecks = useMemo(
    () => protocolCatalog(snapshot.resolvedProtocolVersion ?? versionPin),
    [snapshot.resolvedProtocolVersion, versionPin],
  );
  const protocolPendingIds = pendingIdSet(protocol.result);
  const versionRefusal = liveConformanceVersionRefusal(
    protocol,
    oauth,
    versionPin,
  );
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
  // The verdict compares these to the score's `couldNotRun`, which leaves out
  // unscored checks, so they count only scored checks. Otherwise the headline
  // could blame sign-in or time for checks that stopped for another reason.
  const scoredSuites: Array<
    [Array<{ id: string; details?: unknown }> | undefined, Set<string>]
  > = [
    [protocol.result?.checks, protocolPendingIds],
    [apps.result?.checks, new Set()],
    [tasks.result?.checks, tasksPendingIds],
  ];
  const countScored = (matches: (check: { details?: unknown }) => boolean) =>
    scoredSuites.reduce(
      (count, [checks, pendingIds]) =>
        count +
        (checks?.filter((check) => matches(check) && !pendingIds.has(check.id))
          .length ?? 0),
      0,
    );
  const blockedBySignIn = countScored(isAuthorizationRequiredCheck);
  const timedOut = countScored(isTimedOutCheck);

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
    let outcome: Awaited<ReturnType<ConformanceConnectServer>>;
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

  // Suites finished so far, for the headline while the run is going. One
  // that cannot run on this server counts as finished; one left out of the
  // run is neither done nor to do.
  const runSuites = [protocol, apps, tasks, oauth].filter(
    (suite) => !suite.notSelected,
  );
  const runProgress = {
    done: runSuites.filter(
      (suite) =>
        suite.status !== "idle" &&
        suite.status !== "running" &&
        suite.status !== "needs-authorization",
    ).length,
    total: runSuites.length,
  };
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
      disabled={isRunning || isConnecting || runDisabled}
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
        <ConformanceRunHeader
          serverName={server.name}
          startedAt={startedAt}
          onBack={onShowHome}
          busy={isRunning || isConnecting}
          isConnecting={isConnecting}
          showHistory={showHistory}
          onShowHistory={() => onViewChange("history")}
          onOpenSettings={onOpenSettings}
          settingsLoading={settingsLoading}
          showShare={Boolean(persist)}
          savedRunId={savedRunId}
          // A server the project doesn't have is saved as an external target
          // with no name, and the card and post are public: no name here either.
          shareServerName={persist?.serverId ? server.name : undefined}
          onRunAgain={onRunAgain ? () => onRunAgain(versionPin) : handleRun}
          runDisabled={runDisabled}
        />
      ) : (
        <ConformanceHeader
          view={view}
          onViewChange={(next) =>
            next === "overview" && hasStarted && !isRunning && !isConnecting
              ? onShowHome()
              : onViewChange(next)
          }
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
                {/* Mounted with the run and filled when sign-in is needed: a
                    live region that arrives with its text already in it is not
                    announced by every screen reader. */}
                <p
                  role="status"
                  className="sr-only"
                  data-testid="conformance-oauth-announcement"
                >
                  {oauth.waitingForAuth
                    ? "This run is waiting for you to sign in."
                    : ""}
                </p>
                {oauth.waitingForAuth ? (
                  // At the top of the run, and pinned there while it scrolls:
                  // the run cannot finish until someone signs in, and inside
                  // the OAuth suite at the end of the page this read as a run
                  // that never stops loading.
                  <div
                    data-testid="conformance-oauth-prompt"
                    className="sticky top-0 z-10 mb-3 space-y-2 rounded-lg border border-border bg-popover px-4 py-3 text-sm shadow-sm"
                  >
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
                    {/* Always offer a way forward: a blocked popup used to
                        leave the spinner alone until the session expired. */}
                    <div className="flex gap-2">
                      {oauth.authorizationUrl ? (
                        <Button
                          size="sm"
                          variant={oauth.popupBlocked ? "default" : "outline"}
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
                ) : null}
                <ConformanceVersionNotice
                  refusal={versionRefusal}
                  serverName={server.name}
                />
                <OverallScoreCard
                  score={pooledScore}
                  serverName={server.name}
                  version={
                    pooledScore?.protocolVersion ??
                    snapshot.resolvedProtocolVersion ??
                    (versionPin === "auto" ? "Auto" : versionPin)
                  }
                  isRunning={isRunning}
                  progress={runProgress}
                  serverIconUrl={serverIconUrl}
                  oauthNotScored={oauthNotScored}
                  blockedBySignIn={blockedBySignIn}
                  timedOut={timedOut}
                />

                {waitingOnAuthorization > 0 && (
                  <div className="mt-3 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm leading-relaxed">
                    This server requires sign-in, and this run had no valid
                    session, so the checks that need it could not run. Reconnect
                    the server with OAuth from the server menu, or update its
                    access token, then run again.
                  </div>
                )}

                {timedOut > 0 && (
                  <div className="mt-3 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm leading-relaxed">
                    The server did not answer some checks in time. A timeout
                    does not count as a failure, but those checks are untested,
                    so the score is incomplete. Run the checks again once the
                    server is responding.
                  </div>
                )}

                <ConformanceAdvice
                  key={`${runVersion}-advice`}
                  groups={suiteAdviceGroups({ protocol, apps, tasks, oauth })}
                />

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
                        <UncheckedAdvice
                          unchecked={tasks.result.uncheckedAdvice}
                        />
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
                      // The sign-in prompt itself sits at the top of the run.
                      // A blocked popup is not loading: a spinner here would
                      // read as a run that never finishes.
                      <div className="flex items-center gap-2 py-3 pl-7 text-sm text-muted-foreground">
                        {oauth.popupBlocked ? (
                          <AlertTriangle
                            className="h-3.5 w-3.5 text-amber-500"
                            data-testid="conformance-oauth-suite-blocked"
                          />
                        ) : (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        )}
                        Waiting for sign-in. Use the prompt at the top of the
                        run.
                      </div>
                    ) : oauth.result ? (
                      <div>
                        {oauth.result.steps.map((step) => (
                          <OAuthStepRow
                            key={`${runVersion}-${step.step}`}
                            step={step}
                            pending={oauthUnscored.includes(step.step)}
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
