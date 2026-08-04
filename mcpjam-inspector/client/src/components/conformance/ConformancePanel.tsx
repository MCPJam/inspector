import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { EmptyState } from "@/components/ui/empty-state";
import {
  CheckCircle2,
  XCircle,
  MinusCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  FlaskConical,
} from "lucide-react";
import type { ServerWithName } from "@/hooks/use-app-state";
import type {
  MCPConformanceResult,
  MCPAppsConformanceResult,
  MCPCheckResult,
  MCPAppsCheckResult,
  MCPTasksConformanceResult,
  MCPTasksCheckResult,
  OAuthConformanceStepResult,
} from "@mcpjam/sdk";
// Import from the browser-safe SDK entry — the top-level `@mcpjam/sdk` pulls
// Node-only transitive deps (MCP client SDK uses `node:stream`, etc.) which
// break the Vite browser bundle.
import {
  APPS_CHECK_CATALOG,
  canRunConformance,
  CHECK_ERAS,
  CONFORMANCE_CHECK_METADATA,
  describeConformanceScore,
  MCP_APPS_CHECK_IDS,
  MCP_CHECK_IDS,
  MCP_PROTOCOL_VERSIONS,
  MCP_TASKS_CHECK_IDS,
  pooledConformanceScore,
  PROTOCOL_CHECK_CATALOG,
  PROTOCOL_VERSION_ERAS,
  scoreFromAppsResult,
  scoreFromOAuthResult,
  scoreFromProtocolResult,
  scoreFromTasksResult,
  TASKS_CHECK_CATALOG,
  type ConformanceScore,
  type McpProtocolVersion,
  type OAuthConformanceCheckId,
} from "@mcpjam/sdk/browser";
import type { OAuthConformanceStartResult } from "@/lib/apis/mcp-conformance-api";
import {
  runProtocolConformance,
  runAppsConformance,
  runTasksConformance,
  startOAuthConformance,
  submitOAuthConformanceCode,
  completeOAuthConformance,
} from "@/lib/apis/mcp-conformance-api";
import { deriveOAuthProfileFromServer } from "@/components/oauth/utils";

type SuiteStatus = "idle" | "running" | "done" | "error" | "unavailable";

/** "auto" ⇒ no pin: the run adopts whatever version the server negotiates. */
type ProtocolVersionPin = "auto" | McpProtocolVersion;

/** One row in a suite's "what this will run" preview, before any run. */
interface CatalogEntry {
  id: string;
  title: string;
  /** One-line explanation, revealed on click. */
  description?: string;
  /** Era restriction, shown only when no version is pinned. */
  note?: string;
}

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

interface SuiteState {
  status: SuiteStatus;
  error?: string;
  unavailableReason?: string;
  /**
   * The verdict of a finished run. "Done" only says the run ended — a suite
   * that finished with failures must not read as green.
   */
  verdict?: "passed" | "failed" | "incomplete";
}

interface ProtocolSuiteState extends SuiteState {
  result?: MCPConformanceResult;
}

interface AppsSuiteState extends SuiteState {
  result?: MCPAppsConformanceResult;
}

interface TasksSuiteState extends SuiteState {
  result?: MCPTasksConformanceResult;
}

interface OAuthSuiteState extends SuiteState {
  result?: OAuthConformanceStartResult["result"];
  sessionId?: string;
  waitingForAuth?: boolean;
}

function isHttpServer(server: ServerWithName): boolean {
  // `server.config` is typed required but can be undefined during hosted
  // hydration — guard before using the `in` operator to avoid a TypeError.
  return !!server.config && "url" in server.config;
}

function suiteState(
  suite: "protocol" | "oauth" | "apps" | "tasks",
  server: ServerWithName,
): SuiteState {
  // The SDK's `canRunConformance` is the source of truth for which suites
  // support which transports. It handles null/undefined configs gracefully.
  const support = canRunConformance(
    suite,
    server.config as Parameters<typeof canRunConformance>[1],
  );
  return support.supported
    ? { status: "idle" }
    : { status: "unavailable", unavailableReason: support.reason };
}

function createProtocolState(server: ServerWithName): ProtocolSuiteState {
  return suiteState("protocol", server);
}

function createAppsState(server: ServerWithName): AppsSuiteState {
  return suiteState("apps", server);
}

function createTasksState(server: ServerWithName): TasksSuiteState {
  return suiteState("tasks", server);
}

function createOAuthState(server: ServerWithName): OAuthSuiteState {
  return suiteState("oauth", server);
}

/**
 * A server that requires no authorization has no OAuth obligations to test —
 * authorization is OPTIONAL in every MCP revision — so the suite reports
 * `not-applicable`. That is not a result to render as red: it reuses the same
 * "unavailable" treatment as a transport that cannot run the suite.
 */
function oauthStateFromResult(
  result: NonNullable<OAuthConformanceStartResult["result"]>,
): OAuthSuiteState {
  if (result.outcome === "not-applicable") {
    return {
      status: "unavailable",
      unavailableReason: result.summary,
      // Kept so the score pool can see the run: a not-applicable OAuth run
      // contributes its "nothing to score here" tally instead of vanishing.
      result,
    };
  }
  return {
    status: "done",
    result,
    // OAuth now reports the same three-value verdict as the other suites
    // (plus its own not-applicable, handled above), so an incomplete flow is
    // badged amber rather than flattened to failed.
    verdict:
      result.outcome === "incomplete"
        ? "incomplete"
        : result.passed
          ? "passed"
          : "failed",
  };
}

function StatusIcon({ status }: { status: string }) {
  if (status === "passed") {
    return (
      <CheckCircle2 className="h-3.5 w-3.5 text-green-500 flex-shrink-0" />
    );
  }
  if (status === "failed") {
    return <XCircle className="h-3.5 w-3.5 text-red-500 flex-shrink-0" />;
  }
  return (
    <MinusCircle className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
  );
}

function formatDetailLabel(label: string) {
  return label
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^\w/, (char) => char.toUpperCase());
}

function formatDetailValue(value: unknown) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function CheckRow({
  check,
}: {
  check: MCPCheckResult | MCPAppsCheckResult | MCPTasksCheckResult;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailEntries = Object.entries(check.details ?? {});
  const warnings = "warnings" in check ? check.warnings : undefined;

  return (
    <div className="border-b border-border/30 last:border-0">
      <button
        type="button"
        className="w-full flex items-center gap-2 py-1.5 px-1 text-left hover:bg-muted/30 transition-colors cursor-pointer"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <StatusIcon status={check.status} />
        <span className="text-xs flex-1 min-w-0 truncate">{check.title}</span>
        {expanded ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground flex-shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground flex-shrink-0" />
        )}
        <span className="text-[10px] text-muted-foreground flex-shrink-0">
          {check.durationMs}ms
        </span>
      </button>
      {expanded && (
        <div className="space-y-2 px-6 pb-2">
          <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words">
            {check.description}
          </div>

          {detailEntries.length > 0 && (
            <div className="rounded-sm bg-muted/20 px-2 py-1.5 space-y-1">
              {detailEntries.map(([key, value]) => (
                <div key={key} className="text-xs">
                  <span className="font-medium text-foreground/80">
                    {formatDetailLabel(key)}:
                  </span>{" "}
                  <span className="text-muted-foreground whitespace-pre-wrap break-words">
                    {formatDetailValue(value)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {warnings && warnings.length > 0 && (
            <div className="rounded-sm bg-muted/20 px-2 py-1.5 text-xs text-muted-foreground">
              <div className="mb-1 flex items-center gap-1 font-medium text-foreground/70">
                <AlertTriangle className="h-3 w-3" />
                Warnings
              </div>
              <ul className="space-y-1 pl-4 list-disc">
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}

          {check.error && (
            <div className="rounded-sm border border-red-500/20 bg-red-500/5 px-2 py-1.5 text-xs text-red-400 whitespace-pre-wrap break-words">
              {check.error.message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function OAuthStepRow({ step }: { step: OAuthConformanceStepResult }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b border-border/30 last:border-0">
      <button
        type="button"
        className="w-full flex items-center gap-2 py-1.5 px-1 text-left hover:bg-muted/30 transition-colors cursor-pointer"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <StatusIcon status={step.status} />
        <span className="text-xs flex-1 min-w-0 truncate">{step.title}</span>
        {expanded ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground flex-shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground flex-shrink-0" />
        )}
        <span className="text-[10px] text-muted-foreground flex-shrink-0">
          {step.durationMs}ms
        </span>
      </button>
      {expanded && (
        <div className="space-y-2 px-6 pb-2">
          <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words">
            {step.summary}
          </div>

          {step.teachableMoments && step.teachableMoments.length > 0 && (
            <div className="rounded-sm bg-muted/20 px-2 py-1.5 text-xs text-muted-foreground">
              <div className="mb-1 font-medium text-foreground/70">
                Why this matters
              </div>
              <ul className="space-y-1 pl-4 list-disc">
                {step.teachableMoments.map((moment) => (
                  <li key={moment}>{moment}</li>
                ))}
              </ul>
            </div>
          )}

          {step.warnings && step.warnings.length > 0 && (
            <div className="rounded-sm bg-muted/20 px-2 py-1.5 text-xs text-muted-foreground">
              <div className="mb-1 flex items-center gap-1 font-medium text-foreground/70">
                <AlertTriangle className="h-3 w-3" />
                Warnings
              </div>
              <ul className="space-y-1 pl-4 list-disc">
                {step.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}

          {/* What was actually probed. Without this a reader is told the
              server "does not implement" something without learning which
              URLs were tried — the difference between a verdict and a fix. */}
          {step.httpAttempts && step.httpAttempts.length > 0 && (
            <div className="rounded-sm bg-muted/20 px-2 py-1.5 text-xs text-muted-foreground">
              <div className="mb-1 font-medium text-foreground/70">
                {step.httpAttempts.length === 1 ? "Request" : "Requests tried"}
              </div>
              <ul className="space-y-1">
                {step.httpAttempts.map((attempt, index) => (
                  <li
                    key={`${attempt.request.url}-${index}`}
                    className="flex items-baseline gap-2"
                  >
                    <span className="flex-shrink-0 font-mono text-[10px] uppercase text-foreground/60">
                      {attempt.request.method}
                    </span>
                    <span className="min-w-0 break-all font-mono text-[10px]">
                      {attempt.request.url}
                    </span>
                    {attempt.response && (
                      <span
                        className={`flex-shrink-0 font-mono text-[10px] ${
                          attempt.response.status >= 400
                            ? "text-red-400"
                            : "text-foreground/60"
                        }`}
                      >
                        {attempt.response.status}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {step.error && (
            <div className="rounded-sm border border-red-500/20 bg-red-500/5 px-2 py-1.5 text-xs text-red-400 whitespace-pre-wrap break-words">
              {step.error.message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A not-yet-run check. Mirrors {@link CheckRow}'s interaction so the preview
 * and the real results read as the same list in two states.
 */
function CatalogRow({ entry }: { entry: CatalogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const expandable = Boolean(entry.description);

  return (
    <div className="border-b border-border/30 last:border-0">
      <button
        type="button"
        className="w-full flex items-center gap-2 py-1.5 px-1 text-left transition-colors enabled:hover:bg-muted/30 enabled:cursor-pointer disabled:cursor-default"
        onClick={() => setExpanded((value) => !value)}
        disabled={!expandable}
        aria-expanded={expandable ? expanded : undefined}
      >
        <MinusCircle className="h-3.5 w-3.5 text-muted-foreground/50 flex-shrink-0" />
        <span className="flex-1 min-w-0 truncate text-xs text-muted-foreground">
          {entry.title}
        </span>
        {entry.note && (
          <span className="flex-shrink-0 text-[10px] text-muted-foreground/70">
            {entry.note}
          </span>
        )}
        {expandable &&
          (expanded ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground flex-shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground flex-shrink-0" />
          ))}
      </button>
      {expanded && entry.description && (
        <div className="px-6 pb-2 text-xs text-muted-foreground whitespace-pre-wrap break-words">
          {entry.description}
        </div>
      )}
    </div>
  );
}

function SuiteSection({
  title,
  state,
  catalog,
  catalogNote,
  hasResult,
  score,
  children,
}: {
  title: string;
  state: SuiteState;
  /** What this suite runs, shown until a real result replaces it. */
  catalog: CatalogEntry[];
  catalogNote?: string;
  hasResult: boolean;
  /** This suite's score chip, rendered beside the verdict badge. */
  score?: ConformanceScore;
  children?: React.ReactNode;
}) {
  // `null` follows the suite: one that is running or finished opens itself, an
  // idle one stays shut. Clicking pins an explicit choice until the next run
  // remounts. Tracking `running` — not just `hasResult` — matters most for
  // OAuth, whose section would otherwise snap shut the moment the browser
  // callback lands and the run moves from "waiting for auth" to polling.
  const [override, setOverride] = useState<boolean | null>(null);
  const running = state.status === "running";
  const collapsible = state.status !== "unavailable";
  const expanded = collapsible && (override ?? (hasResult || running));

  const badge = (() => {
    if (state.status === "running") {
      return (
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Running
        </span>
      );
    }
    if (state.status === "unavailable") {
      return (
        <span className="text-[10px] text-muted-foreground">Unavailable</span>
      );
    }
    if (state.status === "error") {
      return <span className="text-[10px] text-red-400">Error</span>;
    }
    if (state.status === "done") {
      if (state.verdict === "failed") {
        return <span className="text-[10px] text-red-400">Failed</span>;
      }
      if (state.verdict === "incomplete") {
        return (
          <span className="text-[10px] text-amber-500">Incomplete</span>
        );
      }
      return <span className="text-[10px] text-green-500">Passed</span>;
    }
    return null;
  })();

  return (
    <div className="rounded-md border border-border/50 overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center justify-between gap-2 px-3 py-2 bg-muted/30 text-left transition-colors enabled:hover:bg-muted/50 disabled:cursor-default"
        onClick={() => setOverride(!expanded)}
        disabled={!collapsible}
        aria-expanded={collapsible ? expanded : undefined}
      >
        <span className="flex items-center gap-1.5 min-w-0">
          {collapsible &&
            (expanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
            ))}
          <span className="text-sm font-medium truncate">{title}</span>
        </span>
        <span className="flex items-center gap-2">
          {score && score.score !== null && (
            <span className="text-[10px] font-semibold tabular-nums text-foreground">
              {score.score}/100
            </span>
          )}
          {badge}
        </span>
      </button>
      <div className="px-2 py-1">
        {state.status === "unavailable" && state.unavailableReason && (
          <div className="flex items-center gap-1.5 px-1 py-2 text-xs text-muted-foreground">
            <AlertTriangle className="h-3 w-3 flex-shrink-0" />
            {state.unavailableReason}
          </div>
        )}
        {state.status === "error" && state.error && (
          <div className="px-1 py-2 text-xs text-red-400">{state.error}</div>
        )}
        {expanded &&
          (hasResult ? (
            children
          ) : running ? (
            // Mid-run with nothing to show yet: the catalog would read as
            // "not run yet", which is exactly wrong while the run is live.
            <div className="flex items-center gap-2 px-1 py-3 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Running {catalog.length} checks...
            </div>
          ) : (
            <div>
              <div className="px-1 py-1 text-[10px] text-muted-foreground">
                {catalog.length} checks in this suite — not run yet.
                {catalogNote ? ` ${catalogNote}` : ""}
              </div>
              {catalog.map((entry) => (
                <CatalogRow key={entry.id} entry={entry} />
              ))}
            </div>
          ))}
      </div>
    </div>
  );
}

function ConformanceContent({ server }: { server: ServerWithName }) {
  const httpServer = isHttpServer(server);
  const [protocol, setProtocol] = useState<ProtocolSuiteState>(() =>
    createProtocolState(server),
  );
  const [apps, setApps] = useState<AppsSuiteState>(() =>
    createAppsState(server),
  );
  const [tasks, setTasks] = useState<TasksSuiteState>(() =>
    createTasksState(server),
  );
  const [oauth, setOAuth] = useState<OAuthSuiteState>(() =>
    createOAuthState(server),
  );
  const [versionPin, setVersionPin] = useState<ProtocolVersionPin>("auto");
  const [runVersion, setRunVersion] = useState(0);

  const activeServerNameRef = useRef(server.name);
  const latestRunTokenRef = useRef(0);
  const oauthListenerCleanupRef = useRef<(() => void) | null>(null);

  const clearOAuthListeners = useCallback(() => {
    oauthListenerCleanupRef.current?.();
    oauthListenerCleanupRef.current = null;
  }, []);

  const beginRun = useCallback(() => {
    latestRunTokenRef.current += 1;
    clearOAuthListeners();
    return latestRunTokenRef.current;
  }, [clearOAuthListeners]);

  const isRunActive = useCallback(
    (runToken: number, serverName: string) =>
      latestRunTokenRef.current === runToken &&
      activeServerNameRef.current === serverName,
    [],
  );

  const resetStates = useCallback(
    (serverName?: string) => {
      const effectiveServerName = serverName ?? activeServerNameRef.current;
      latestRunTokenRef.current += 1;
      clearOAuthListeners();
      setRunVersion((value) => value + 1);
      setProtocol(createProtocolState(server));
      setApps(createAppsState(server));
      setTasks(createTasksState(server));
      setOAuth(createOAuthState(server));
      activeServerNameRef.current = effectiveServerName;
    },
    [clearOAuthListeners, server],
  );

  useEffect(() => {
    resetStates(server.name);
  }, [server.name, resetStates]);

  useEffect(
    () => () => {
      latestRunTokenRef.current += 1;
      clearOAuthListeners();
    },
    [clearOAuthListeners],
  );

  const runProtocol = useCallback(
    async (runToken: number, serverName: string) => {
      if (!httpServer) return;
      setProtocol({ status: "running" });
      try {
        const { result } = await runProtocolConformance(serverName, {
          protocolVersion: versionPin === "auto" ? undefined : versionPin,
        });
        if (!isRunActive(runToken, serverName)) return;
        setProtocol({
          status: "done",
          result,
          // All four suites now report a three-value outcome, so an
          // incomplete run is badged as such rather than flattened to failed.
          verdict:
            result.outcome === "incomplete"
              ? "incomplete"
              : result.passed
                ? "passed"
                : "failed",
        });
      } catch (err) {
        if (!isRunActive(runToken, serverName)) return;
        setProtocol({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [httpServer, isRunActive, versionPin],
  );

  const runApps = useCallback(
    async (runToken: number, serverName: string) => {
      setApps({ status: "running" });
      try {
        const { result } = await runAppsConformance(serverName);
        if (!isRunActive(runToken, serverName)) return;
        setApps({
          status: "done",
          result,
          // All four suites now report a three-value outcome, so an
          // incomplete run is badged as such rather than flattened to failed.
          verdict:
            result.outcome === "incomplete"
              ? "incomplete"
              : result.passed
                ? "passed"
                : "failed",
        });
      } catch (err) {
        if (!isRunActive(runToken, serverName)) return;
        setApps({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [isRunActive],
  );

  const runTasks = useCallback(
    async (runToken: number, serverName: string) => {
      setTasks({ status: "running" });
      try {
        const { result } = await runTasksConformance(serverName);
        if (!isRunActive(runToken, serverName)) return;
        setTasks({
          status: "done",
          result,
          // The tasks suite reports a real third outcome: checks that apply but
          // could not be exercised leave the run incomplete, never passing.
          verdict:
            result.outcome === "incomplete"
              ? "incomplete"
              : result.passed
                ? "passed"
                : "failed",
        });
      } catch (err) {
        if (!isRunActive(runToken, serverName)) return;
        setTasks({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [isRunActive],
  );

  const pollOAuthComplete = useCallback(
    async (sessionId: string, runToken: number, serverName: string) => {
      const MAX_POLLS = 10;
      for (let i = 0; i < MAX_POLLS; i++) {
        try {
          const poll = await completeOAuthConformance(sessionId);
          if (!isRunActive(runToken, serverName)) return;
          if (poll.phase === "complete" && poll.result) {
            setOAuth(oauthStateFromResult(poll.result));
            return;
          }
        } catch (err) {
          if (!isRunActive(runToken, serverName)) return;
          setOAuth({
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }
      }

      if (!isRunActive(runToken, serverName)) return;
      setOAuth({ status: "error", error: "OAuth conformance timed out" });
    },
    [isRunActive],
  );

  const handleOAuthCallback = useCallback(
    async (
      sessionId: string,
      code: string,
      runToken: number,
      serverName: string,
      state?: string,
    ) => {
      try {
        await submitOAuthConformanceCode({ sessionId, code, state });
        if (!isRunActive(runToken, serverName)) return;
        setOAuth((prev) => ({
          ...prev,
          waitingForAuth: false,
          status: "running",
        }));
        await pollOAuthComplete(sessionId, runToken, serverName);
      } catch (err) {
        if (!isRunActive(runToken, serverName)) return;
        setOAuth({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [isRunActive, pollOAuthComplete],
  );

  const runOAuth = useCallback(
    async (runToken: number, currentServer: ServerWithName) => {
      if (!isHttpServer(currentServer)) return;

      const serverName = currentServer.name;
      setOAuth({ status: "running" });

      try {
        const profile = deriveOAuthProfileFromServer(currentServer);
        // Always send callbackOrigin — both local and hosted modes redirect
        // back to the inspector's own `/oauth/callback/debug` page so the
        // server can surface the code back to the SDK runner.
        const callbackOrigin = window.location.origin;

        // A run-scoped version pin beats the stored OAuth-tab profile, and
        // must be sent even when the profile is otherwise empty (the route
        // falls back to its own default version when no profile arrives).
        const pinnedVersion = versionPin === "auto" ? undefined : versionPin;
        const baseProfile = profile.serverUrl
          ? {
              serverUrl: profile.serverUrl,
              protocolVersion: profile.protocolVersion,
              registrationStrategy: profile.registrationStrategy,
              clientId: profile.clientId || undefined,
              clientSecret: profile.clientSecret || undefined,
              scopes: profile.scopes || undefined,
              customHeaders: profile.customHeaders.length
                ? profile.customHeaders
                : undefined,
            }
          : undefined;

        const startResult = await startOAuthConformance({
          serverNameOrId: serverName,
          oauthProfile: pinnedVersion
            ? { ...baseProfile, protocolVersion: pinnedVersion }
            : baseProfile,
          callbackOrigin,
        });

        if (!isRunActive(runToken, serverName)) return;

        if (startResult.phase === "complete" && startResult.result) {
          setOAuth(oauthStateFromResult(startResult.result));
          return;
        }

        if (
          startResult.phase === "authorization_needed" &&
          startResult.sessionId &&
          startResult.authorizationUrl
        ) {
          const sessionId = startResult.sessionId;
          setOAuth({
            status: "running",
            sessionId,
            waitingForAuth: true,
          });

          window.open(
            startResult.authorizationUrl,
            "oauth_conformance_auth",
            "width=600,height=700,scrollbars=yes",
          );

          const cleanupFns: Array<() => void> = [];
          const cleanup = () => {
            for (const fn of cleanupFns) fn();
            if (oauthListenerCleanupRef.current === cleanup) {
              oauthListenerCleanupRef.current = null;
            }
          };
          oauthListenerCleanupRef.current = cleanup;

          const handleMessage = (event: MessageEvent) => {
            if (event.data?.type !== "OAUTH_CALLBACK" || !event.data?.code) {
              return;
            }
            cleanup();
            void handleOAuthCallback(
              sessionId,
              event.data.code,
              runToken,
              serverName,
              event.data.state,
            );
          };

          window.addEventListener("message", handleMessage);
          cleanupFns.push(() =>
            window.removeEventListener("message", handleMessage),
          );

          try {
            const channel = new BroadcastChannel("oauth_callback_channel");
            channel.onmessage = (event) => {
              if (event.data?.type !== "OAUTH_CALLBACK" || !event.data?.code) {
                return;
              }
              cleanup();
              void handleOAuthCallback(
                sessionId,
                event.data.code,
                runToken,
                serverName,
                event.data.state,
              );
            };
            cleanupFns.push(() => channel.close());
          } catch {
            // BroadcastChannel not available
          }

          // Both local and hosted modes now rely on the `/oauth/authorize`
          // endpoint to deliver the code; polling without a code submission
          // would time out, so we defer all polling to `handleOAuthCallback`.
        }
      } catch (err) {
        if (!isRunActive(runToken, currentServer.name)) return;
        setOAuth({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [handleOAuthCallback, isRunActive, pollOAuthComplete, versionPin],
  );

  const runAll = useCallback(async () => {
    const runToken = beginRun();
    const currentServer = server;
    const httpServerNow = isHttpServer(currentServer);

    setRunVersion((value) => value + 1);
    setProtocol(createProtocolState(currentServer));
    setApps(createAppsState(currentServer));
    setTasks(createTasksState(currentServer));
    setOAuth(createOAuthState(currentServer));

    const promises: Promise<void>[] = [];
    if (httpServerNow) {
      promises.push(runProtocol(runToken, currentServer.name));
    }
    promises.push(runApps(runToken, currentServer.name));
    promises.push(runTasks(runToken, currentServer.name));
    if (httpServerNow) {
      promises.push(runOAuth(runToken, currentServer));
    }

    await Promise.allSettled(promises);
  }, [beginRun, runApps, runOAuth, runProtocol, runTasks, server]);

  const protocolChecks = useMemo(
    () => protocolCatalog(versionPin),
    [versionPin],
  );

  // Scores are derived, never stored: each finished suite contributes, and
  // the headline pools their COUNTS (not an average of suite scores), so a
  // 0-for-9 OAuth run stays visible inside 30 protocol passes.
  const protocolScore = useMemo(
    () => (protocol.result ? scoreFromProtocolResult(protocol.result) : undefined),
    [protocol.result],
  );
  const appsScore = useMemo(
    () => (apps.result ? scoreFromAppsResult(apps.result) : undefined),
    [apps.result],
  );
  const tasksScore = useMemo(
    () => (tasks.result ? scoreFromTasksResult(tasks.result) : undefined),
    [tasks.result],
  );
  const oauthScore = useMemo(
    () => (oauth.result ? scoreFromOAuthResult(oauth.result) : undefined),
    [oauth.result],
  );
  const pooledScore = useMemo(() => {
    const parts = [protocolScore, appsScore, tasksScore, oauthScore].filter(
      (part): part is ConformanceScore => part !== undefined,
    );
    return parts.length > 0 ? pooledConformanceScore(parts) : undefined;
  }, [protocolScore, appsScore, tasksScore, oauthScore]);
  const oauthNotScored =
    oauthScore !== undefined && oauthScore.score === null;

  const isRunning =
    protocol.status === "running" ||
    apps.status === "running" ||
    tasks.status === "running" ||
    oauth.status === "running";

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="space-y-1 border-b border-border/50 pb-4">
        <h2 className="text-lg font-semibold">Conformance</h2>
        <p className="text-sm text-muted-foreground">
          Run Protocol, Apps, Tasks, and OAuth checks against {server.name}.
        </p>
      </div>

      {/* No card at all when nothing was applicable: a "—/100" over a run
          with nothing to score would be noise dressed as a number. */}
      {pooledScore && pooledScore.score !== null && (
        <div className="mt-4 flex items-center gap-4 rounded-md border border-border/50 bg-muted/30 px-4 py-3">
          <div className="text-3xl font-semibold tabular-nums leading-none">
            {pooledScore.score}
            <span className="ml-0.5 text-sm font-normal text-muted-foreground">
              /100
            </span>
          </div>
          <div className="min-w-0 space-y-0.5">
            <div
              className={`text-xs font-medium ${
                pooledScore.outcome === "failed"
                  ? "text-red-400"
                  : pooledScore.outcome === "incomplete"
                    ? "text-amber-500"
                    : "text-green-500"
              }`}
            >
              {pooledScore.outcome === "failed"
                ? "Not conformant"
                : pooledScore.outcome === "incomplete"
                  ? "Incomplete run"
                  : pooledScore.advisories.length > 0
                    ? "Conformant, with advice"
                    : "Fully conformant"}
            </div>
            {/* The denominator and version travel with the number, always —
                "100 of 11 applicable" and "100 of 38" are different servers. */}
            <div className="truncate text-[11px] text-muted-foreground">
              {describeConformanceScore(pooledScore)}
              {pooledScore.notApplicable > 0
                ? ` · ${pooledScore.notApplicable} not applicable`
                : ""}
              {oauthNotScored ? " · OAuth not applicable (no auth) — not scored" : ""}
            </div>
          </div>
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-2">
        <Button size="sm" onClick={runAll} disabled={isRunning}>
          {isRunning ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              Running...
            </>
          ) : (
            "Run available checks"
          )}
        </Button>
        <div className="flex items-center gap-2">
          <label
            htmlFor="conformance-protocol-version"
            className="text-xs text-muted-foreground"
          >
            Protocol version
          </label>
          <Select
            value={versionPin}
            onValueChange={(value) => setVersionPin(value as ProtocolVersionPin)}
            disabled={isRunning}
          >
            <SelectTrigger
              id="conformance-protocol-version"
              className="h-8 w-[170px] text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto (negotiated)</SelectItem>
              {MCP_PROTOCOL_VERSIONS.map((version) => (
                <SelectItem key={version} value={version}>
                  {version}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="mt-4 space-y-4 overflow-y-auto pr-1">
        <SuiteSection
          key={`${runVersion}-protocol`}
          title="Protocol"
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
              <div className="px-1 py-1 text-[10px] text-muted-foreground">
                {protocol.result.summary}
              </div>
              {(protocol.result.readiness ?? []).length > 0 && (
                <div className="mx-1 my-1 space-y-1 rounded-sm border border-amber-500/50 px-2 py-1.5">
                  {(protocol.result.readiness ?? []).map((warning) => (
                    <div
                      key={warning.id}
                      className="flex items-start gap-1.5 text-[11px]"
                    >
                      <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0 text-amber-500" />
                      <span className="min-w-0">
                        <span className="font-medium">{warning.title}</span>{" "}
                        <span className="text-muted-foreground">
                          ({warning.specStrength})
                        </span>{" "}
                        — {warning.message}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {protocol.result.checks.map((check) => (
                <CheckRow key={`${runVersion}-${check.id}`} check={check} />
              ))}
            </div>
          ) : null}
        </SuiteSection>

        <SuiteSection
          key={`${runVersion}-apps`}
          title="Apps"
          state={apps}
          score={appsScore}
          catalog={APPS_CATALOG}
          hasResult={Boolean(apps.result)}
        >
          {apps.result ? (
            <div>
              <div className="px-1 py-1 text-[10px] text-muted-foreground">
                {apps.result.summary}
              </div>
              {apps.result.checks.map((check) => (
                <CheckRow key={`${runVersion}-${check.id}`} check={check} />
              ))}
            </div>
          ) : null}
        </SuiteSection>

        <SuiteSection
          key={`${runVersion}-tasks`}
          title="Tasks"
          state={tasks}
          score={tasksScore}
          catalog={TASKS_CATALOG}
          hasResult={Boolean(tasks.result)}
        >
          {tasks.result ? (
            <div>
              <div className="px-1 py-1 text-[10px] text-muted-foreground">
                {tasks.result.summary} (wire: {tasks.result.discovery.wire})
              </div>
              {tasks.result.checks.map((check) => (
                <CheckRow key={`${runVersion}-${check.id}`} check={check} />
              ))}
            </div>
          ) : null}
        </SuiteSection>

        <SuiteSection
          key={`${runVersion}-oauth`}
          title="OAuth"
          state={oauth}
          score={oauthScore}
          catalog={OAUTH_CATALOG}
          catalogNote="The authorization flow steps are recorded as the run proceeds."
          hasResult={Boolean(oauth.result) || Boolean(oauth.waitingForAuth)}
        >
          {oauth.waitingForAuth ? (
            <div className="flex items-center gap-2 px-1 py-3 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Waiting for browser authorization...
            </div>
          ) : oauth.result ? (
            <div>
              <div className="px-1 py-1 text-[10px] text-muted-foreground">
                {oauth.result.summary}
              </div>
              {oauth.result.steps.map((step) => (
                <OAuthStepRow key={`${runVersion}-${step.step}`} step={step} />
              ))}
            </div>
          ) : null}
        </SuiteSection>
      </div>
    </div>
  );
}

export function ConformanceTab({
  server,
}: {
  server?: ServerWithName | null;
}) {
  // In hosted mode `selectedMCPConfig` can arrive as a stub with falsy name
  // and/or missing config while the project is still hydrating — treat any
  // non-connected shape as "no server selected" so the panel never runs
  // against `undefined` (which would surface as "Hosted server not found
  // for 'undefined'" when Apps conformance calls the hosted resolver).
  if (!server || !server.name || server.name === "none" || !server.config) {
    return (
      <EmptyState
        icon={FlaskConical}
        title="No server selected"
        description="Select a connected server above to run conformance checks."
        className="h-full"
      />
    );
  }

  return (
    <div className="h-full overflow-hidden p-4 lg:p-6">
      <ConformanceContent key={server.name} server={server} />
    </div>
  );
}
