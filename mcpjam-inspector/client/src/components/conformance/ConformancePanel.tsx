import { useEffect, useState, useMemo, type ReactNode } from "react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { Button } from "@mcpjam/design-system/button";
import { DirectoryReadinessSection } from "@/components/conformance/directory-readiness/DirectoryReadinessSection";
import { Loader2, AlertTriangle } from "lucide-react";
import type { ServerWithName } from "@/hooks/use-app-state";
// Import from the browser-safe SDK entry — the top-level `@mcpjam/sdk` pulls
// Node-only transitive deps (MCP client SDK uses `node:stream`, etc.) which
// break the Vite browser bundle.
import {
  APPS_CHECK_CATALOG,
  CHECK_ERAS,
  CONFORMANCE_CHECK_METADATA,
  MCP_APPS_CHECK_IDS,
  MCP_CHECK_IDS,
  MCP_TASKS_CHECK_IDS,
  PROTOCOL_CHECK_CATALOG,
  PROTOCOL_VERSION_ERAS,
  TASKS_CHECK_CATALOG,
  isAuthorizationRequiredCheck,
  type ConformanceScore,
  type OAuthConformanceCheckId,
} from "@mcpjam/sdk/browser";
import {
  OverallScoreCard,
  SUITE_COPY,
  SuiteRow,
  VerdictBadge,
} from "./conformance-ui";
import {
  CatalogRow,
  CheckRow,
  OAuthStepRow,
  pendingIdSet,
  type CatalogEntry,
} from "./ConformanceCheckRows";
import {
  ConformanceHeader,
  ConformancePreRun,
  ConformanceServerPicker,
  ConformanceTabPanel,
  ProtocolVersionSelect,
  RUN_LABEL,
  type ConformanceView,
} from "./ConformancePageChrome";
import { toast } from "@/lib/toast";
import {
  useConformanceRun,
  type ProtocolVersionPin,
  type SuiteState,
} from "@/hooks/use-conformance-run";
import {
  PersistConformanceRun,
  type ConformancePersistConfig,
} from "@/components/conformance/PersistConformanceRun";

/**
 * The protocol suite is era-gated: a pinned version runs only its own era's
 * checks. With a pin we filter to exactly what will run; on "auto" the era is
 * unknown until the connection negotiates, so we list everything and tag the
 * checks that are era-restricted rather than implying they all apply.
 */
function protocolCatalog(pin: ProtocolVersionPin): CatalogEntry[] {
  const pinnedEra = pin === "auto" ? undefined : PROTOCOL_VERSION_ERAS[pin];
  return MCP_CHECK_IDS.filter((id) => {
    const eras = CHECK_ERAS[id] as readonly string[];
    return pinnedEra === undefined || eras.includes(pinnedEra);
  }).map((id) => {
    const eras = CHECK_ERAS[id] as readonly string[];
    return {
      id,
      ...PROTOCOL_CHECK_CATALOG[id],
      note:
        pinnedEra === undefined && eras.length === 1
          ? `${eras[0]} only`
          : undefined,
    };
  });
}

const APPS_CATALOG: CatalogEntry[] = MCP_APPS_CHECK_IDS.map((id) => ({
  id,
  ...APPS_CHECK_CATALOG[id],
}));

const TASKS_CATALOG: CatalogEntry[] = MCP_TASKS_CHECK_IDS.map((id) => ({
  id,
  ...TASKS_CHECK_CATALOG[id],
}));

// Only the post-flow checks have static identities. The authorization flow
// steps themselves depend on the server's registration strategy and protocol
// version, so they are discovered during the run rather than listed here.
const OAUTH_CATALOG: CatalogEntry[] = (
  Object.keys(CONFORMANCE_CHECK_METADATA) as OAuthConformanceCheckId[]
).map((id) => ({
  id,
  title: CONFORMANCE_CHECK_METADATA[id].title,
  description: CONFORMANCE_CHECK_METADATA[id].summary,
}));

function SuiteBadge({ state }: { state: SuiteState }) {
  if (state.status === "running") {
    return <VerdictBadge label="RUNNING" tone="neutral" spinning />;
  }
  if (state.status === "unavailable") {
    return <VerdictBadge label="NOT APPLICABLE" tone="neutral" />;
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
  // pins an explicit choice until the next run remounts.
  const [override, setOverride] = useState<boolean | null>(null);
  const running = state.status === "running";
  const collapsible = state.status !== "unavailable";
  const waitingForAuth = Boolean(
    (state as { waitingForAuth?: boolean }).waitingForAuth,
  );
  const autoOpen =
    waitingForAuth ||
    state.status === "error" ||
    (state.status === "done" && state.verdict !== "passed");
  const expanded = collapsible && (override ?? autoOpen);

  return (
    <SuiteRow
      title={title}
      subtitle={
        state.status === "unavailable" && state.unavailableReason
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
      collapsible={collapsible}
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
      {hasResult ? (
        children
      ) : running ? (
        // Mid-run with nothing to show yet: the catalog would read as
        // "not run yet", which is exactly wrong while the run is live.
        <div className="flex items-center gap-2 py-3 pl-7 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Running {catalog.length} checks...
        </div>
      ) : (
        <div className="pl-7">
          <div className="py-1 text-[11px] text-muted-foreground">
            {catalog.length} checks in this suite — not run yet.
            {catalogNote ? ` ${catalogNote}` : ""}
          </div>
          {catalog.map((entry) => (
            <CatalogRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </SuiteRow>
  );
}

function ConformanceContent({
  server,
  persist,
  view,
  onViewChange,
  showHistory,
  history,
  serverPicker,
}: {
  server: ServerWithName;
  persist?: ConformancePersistConfig;
  view: ConformanceView;
  onViewChange: (view: ConformanceView) => void;
  showHistory: boolean;
  history?: ReactNode;
  serverPicker: ReactNode;
}) {
  // Run state, per-suite scores and the pooled headline all live in the shared
  // hook — score.mcpjam.com runs the same four suites and must pool them the
  // same way. Rendering stays here.
  const snapshot = useConformanceRun({ server });
  const {
    protocol,
    apps,
    tasks,
    oauth,
    versionPin,
    setVersionPin,
    runVersion,
    runAll,
    protocolScore,
    appsScore,
    tasksScore,
    oauthScore,
    pooledScore,
    oauthNotScored,
    isRunning,
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

  // The page opens on the "run your first check" state and only swaps to the
  // suites once a run has begun. Keyed by server, so a server switch resets it.
  const [started, setStarted] = useState(false);
  const handleRun = () => {
    setStarted(true);
    runAll();
  };
  const hasStarted =
    started ||
    isRunning ||
    [protocol, apps, tasks, oauth].some(
      (suite) => suite.status === "done" || suite.status === "error",
    );

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
    <Button size="sm" onClick={handleRun} disabled={isRunning}>
      {isRunning ? (
        <>
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          Running...
        </>
      ) : (
        RUN_LABEL
      )}
    </Button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {persist ? (
        <PersistConformanceRun
          persist={persist}
          server={server}
          snapshot={snapshot}
        />
      ) : null}
      <ConformanceHeader
        view={view}
        onViewChange={onViewChange}
        showHistory={showHistory}
      >
        {serverPicker}
        <ProtocolVersionSelect
          value={versionPin}
          onChange={setVersionPin}
          disabled={isRunning}
        />
        {runButton}
      </ConformanceHeader>

      <ConformanceTabPanel view={view}>
        {view === "history" ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
            {history}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-8 pt-6 pb-8">
            {!hasStarted ? (
              <ConformancePreRun runButton={runButton} />
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
                />

                {waitingOnAuthorization > 0 && (
                  <div className="mt-3 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs leading-relaxed">
                    This server requires sign-in, and this run had no valid
                    session, so {waitingOnAuthorization} check(s) could not
                    run. Reconnect the server with OAuth from the server menu,
                    or update its access token, then run again.
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
                      <div className="flex items-center gap-2 px-1 py-3 text-xs text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Waiting for browser authorization...
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
    </div>
  );
}

/** The server last selected on this page, so the next visit starts there. */
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
  history,
}: {
  server?: ServerWithName | null;
  persist?: ConformancePersistConfig;
  /** Servers offered in the page's picker. Omit to hide the picker. */
  servers?: ServerWithName[];
  onSelectServer?: (name: string) => void;
  /** The History tab's content. Omit to hide the tab. */
  history?: ReactNode;
}) {
  // A run's detail page links back with `?view=history`.
  const [view, setView] = useState<ConformanceView>(() =>
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("view") === "history"
      ? "history"
      : "overview",
  );
  const showHistory = history !== undefined;
  // `?view=history` can outlive the History tab, e.g. a run link opened where
  // no history is passed. With the tabs hidden there would be no way back.
  const activeView: ConformanceView = showHistory ? view : "overview";

  // The app-wide selection can be empty, or a server that is not connected,
  // and the picker then reads "Select a server" while the page still names
  // another one — two connected servers left people unsure which one ran.
  // When the selection is not one this page can run, pick for them: the
  // server last selected here if it is connected, otherwise the first
  // connected.
  const selectionIsOffered = Boolean(
    server?.name && servers?.some((offered) => offered.name === server.name),
  );
  useEffect(() => {
    if (!servers || servers.length === 0 || !onSelectServer) return;
    if (selectionIsOffered) return;
    const remembered = readLastServer();
    const next =
      servers.find((offered) => offered.name === remembered) ?? servers[0]!;
    onSelectServer(next.name);
  }, [servers, onSelectServer, selectionIsOffered]);
  useEffect(() => {
    if (selectionIsOffered && server?.name) rememberServer(server.name);
  }, [selectionIsOffered, server?.name]);

  const serverPicker =
    servers && onSelectServer ? (
      <ConformanceServerPicker
        servers={servers}
        selectedName={server?.name ?? null}
        onSelect={onSelectServer}
      />
    ) : null;

  // In hosted mode `selectedMCPConfig` can arrive as a stub with falsy name
  // and/or missing config while the project is still hydrating — treat any
  // non-connected shape as "no server selected" so the panel never runs
  // against `undefined` (which would surface as "Hosted server not found
  // for 'undefined'" when Apps conformance calls the hosted resolver).
  if (!server || !server.name || server.name === "none" || !server.config) {
    // Same pre-run page as with a server; running just asks for one first.
    const noServerRunButton = (
      <Button
        size="sm"
        onClick={() =>
          toast.info("Connect an MCP server to run conformance checks.")
        }
      >
        {RUN_LABEL}
      </Button>
    );
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <ConformanceHeader
          view={activeView}
          onViewChange={setView}
          showHistory={showHistory}
        >
          {serverPicker}
          <ProtocolVersionSelect value="auto" disabled />
          {noServerRunButton}
        </ConformanceHeader>
        <ConformanceTabPanel view={activeView}>
          {activeView === "history" ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
              {history}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-8 pt-6 pb-8">
              <ConformancePreRun runButton={noServerRunButton} />
            </div>
          )}
        </ConformanceTabPanel>
      </div>
    );
  }

  return (
    <ConformanceContent
      key={server.name}
      server={server}
      persist={persist}
      view={activeView}
      onViewChange={setView}
      showHistory={showHistory}
      history={history}
      serverPicker={serverPicker}
    />
  );
}
