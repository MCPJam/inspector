import { useState, useCallback, useEffect, useRef } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Switch } from "@mcpjam/design-system/switch";
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
  ConformanceReport,
  ConformanceReportCase,
} from "@mcpjam/sdk";
// Import from the browser-safe SDK entry — the top-level `@mcpjam/sdk` pulls
// Node-only transitive deps (MCP client SDK uses `node:stream`, etc.) which
// break the Vite browser bundle.
import {
  canRunConformance,
  renderConformanceReportJson,
  toConformanceReport,
} from "@mcpjam/sdk/browser";
import type { OAuthConformanceStartResult } from "@/lib/apis/mcp-conformance-api";
import {
  runProtocolConformance,
  runAppsConformance,
  startOAuthConformance,
  submitOAuthConformanceCode,
  completeOAuthConformance,
} from "@/lib/apis/mcp-conformance-api";
import { deriveOAuthProfileFromServer } from "@/components/oauth/utils";

type SuiteStatus = "idle" | "running" | "done" | "error" | "unavailable";

interface SuiteState {
  status: SuiteStatus;
  error?: string;
  unavailableReason?: string;
}

interface ConformanceSuiteState extends SuiteState {
  report?: ConformanceReport;
}

interface OAuthSuiteState extends ConformanceSuiteState {
  sessionId?: string;
  waitingForAuth?: boolean;
}

function isHttpServer(server: ServerWithName): boolean {
  // `server.config` is typed required but can be undefined during hosted
  // hydration — guard before using the `in` operator to avoid a TypeError.
  return !!server.config && "url" in server.config;
}

function suiteState(
  suite: "protocol" | "oauth" | "apps",
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

function createProtocolState(server: ServerWithName): ConformanceSuiteState {
  return suiteState("protocol", server);
}

function createAppsState(server: ServerWithName): ConformanceSuiteState {
  return suiteState("apps", server);
}

function createOAuthState(server: ServerWithName): OAuthSuiteState {
  return suiteState("oauth", server);
}

function createDisplayReport(report: ConformanceReport): ConformanceReport {
  return renderConformanceReportJson(report);
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringArray(
  value: unknown,
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.trim().length > 0,
  );
}

function normalizeCaseDetails(reportCase: ConformanceReportCase): {
  detailEntries: Array<[string, unknown]>;
  warnings: string[];
  teachableMoments: string[];
} {
  if (!isPlainObject(reportCase.details)) {
    return {
      detailEntries: [],
      warnings: [],
      teachableMoments: [],
    };
  }

  const rawDetails = reportCase.details;
  const nestedDetails = isPlainObject(rawDetails.details)
    ? Object.entries(rawDetails.details)
    : [];
  const extraEntries = Object.entries(rawDetails).filter(
    ([key]) =>
      key !== "details" && key !== "warnings" && key !== "teachableMoments",
  );

  return {
    detailEntries: [...nestedDetails, ...extraEntries],
    warnings: readStringArray(rawDetails.warnings),
    teachableMoments: readStringArray(rawDetails.teachableMoments),
  };
}

function ReportCaseRow({ reportCase }: { reportCase: ConformanceReportCase }) {
  const [expanded, setExpanded] = useState(false);
  const { detailEntries, warnings, teachableMoments } =
    normalizeCaseDetails(reportCase);

  return (
    <div className="border-b border-border/30 last:border-0">
      <button
        type="button"
        className="w-full flex items-center gap-2 py-1.5 px-1 text-left hover:bg-muted/30 transition-colors cursor-pointer"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <StatusIcon status={reportCase.status} />
        <span className="text-xs flex-1 min-w-0 truncate">
          {reportCase.title}
        </span>
        {expanded ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground flex-shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground flex-shrink-0" />
        )}
        <span className="text-[10px] text-muted-foreground flex-shrink-0">
          {reportCase.durationMs}ms
        </span>
      </button>
      {expanded && (
        <div className="space-y-2 px-6 pb-2">
          <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words">
            {reportCase.description}
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

          {warnings.length > 0 && (
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

          {teachableMoments.length > 0 && (
            <div className="rounded-sm bg-muted/20 px-2 py-1.5 text-xs text-muted-foreground">
              <div className="mb-1 font-medium text-foreground/70">
                Why this matters
              </div>
              <ul className="space-y-1 pl-4 list-disc">
                {teachableMoments.map((moment) => (
                  <li key={moment}>{moment}</li>
                ))}
              </ul>
            </div>
          )}

          {reportCase.output && (
            <div className="rounded-sm bg-muted/20 px-2 py-1.5 text-xs text-muted-foreground whitespace-pre-wrap break-words">
              {reportCase.output}
            </div>
          )}

          {reportCase.error && (
            <div className="rounded-sm border border-red-500/20 bg-red-500/5 px-2 py-1.5 text-xs text-red-400 whitespace-pre-wrap break-words">
              {reportCase.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SuiteSection({
  title,
  state,
  children,
}: {
  title: string;
  state: SuiteState;
  children?: React.ReactNode;
}) {
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
      return <span className="text-[10px] text-green-500">Done</span>;
    }
    return null;
  })();

  return (
    <div className="rounded-md border border-border/50 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-muted/30">
        <span className="text-sm font-medium">{title}</span>
        {badge}
      </div>
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
        {children}
      </div>
    </div>
  );
}

function ConformanceContent({ server }: { server: ServerWithName }) {
  const httpServer = isHttpServer(server);
  const [protocol, setProtocol] = useState<ConformanceSuiteState>(() =>
    createProtocolState(server),
  );
  const [apps, setApps] = useState<ConformanceSuiteState>(() =>
    createAppsState(server),
  );
  const [oauth, setOAuth] = useState<OAuthSuiteState>(() =>
    createOAuthState(server),
  );
  const [negativeChecks, setNegativeChecks] = useState(false);
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
        const response = await runProtocolConformance(serverName);
        if (!isRunActive(runToken, serverName)) return;
        setProtocol({
          status: "done",
          report: response.report
            ? createDisplayReport(response.report)
            : createDisplayReport(toConformanceReport(response.result)),
        });
      } catch (err) {
        if (!isRunActive(runToken, serverName)) return;
        setProtocol({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [httpServer, isRunActive],
  );

  const runApps = useCallback(
    async (runToken: number, serverName: string) => {
      setApps({ status: "running" });
      try {
        const response = await runAppsConformance(serverName);
        if (!isRunActive(runToken, serverName)) return;
        setApps({
          status: "done",
          report: response.report
            ? createDisplayReport(response.report)
            : createDisplayReport(toConformanceReport(response.result)),
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

  const pollOAuthComplete = useCallback(
    async (sessionId: string, runToken: number, serverName: string) => {
      const MAX_POLLS = 10;
      for (let i = 0; i < MAX_POLLS; i++) {
        try {
          const poll = await completeOAuthConformance(sessionId);
          if (!isRunActive(runToken, serverName)) return;
          if (poll.phase === "complete" && poll.result) {
            setOAuth({
              status: "done",
              report: poll.report
                ? createDisplayReport(poll.report)
                : createDisplayReport(toConformanceReport(poll.result)),
            });
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

        const startResult = await startOAuthConformance({
          serverNameOrId: serverName,
          oauthProfile: profile.serverUrl
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
            : undefined,
          runNegativeChecks: negativeChecks,
          callbackOrigin,
        });

        if (!isRunActive(runToken, serverName)) return;

        if (startResult.phase === "complete" && startResult.result) {
          setOAuth({
            status: "done",
            report: startResult.report
              ? createDisplayReport(startResult.report)
              : createDisplayReport(toConformanceReport(startResult.result)),
          });
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
    [handleOAuthCallback, isRunActive, negativeChecks, pollOAuthComplete],
  );

  const runAll = useCallback(async () => {
    const runToken = beginRun();
    const currentServer = server;
    const httpServerNow = isHttpServer(currentServer);

    setRunVersion((value) => value + 1);
    setProtocol(createProtocolState(currentServer));
    setApps(createAppsState(currentServer));
    setOAuth(createOAuthState(currentServer));

    const promises: Promise<void>[] = [];
    if (httpServerNow) {
      promises.push(runProtocol(runToken, currentServer.name));
    }
    promises.push(runApps(runToken, currentServer.name));
    if (httpServerNow) {
      promises.push(runOAuth(runToken, currentServer));
    }

    await Promise.allSettled(promises);
  }, [beginRun, runApps, runOAuth, runProtocol, server]);

  const isRunning =
    protocol.status === "running" ||
    apps.status === "running" ||
    oauth.status === "running";

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-start justify-between gap-4 border-b border-border/50 pb-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Conformance</h2>
          <p className="text-sm text-muted-foreground">
            Run Protocol, Apps, and OAuth checks against {server.name}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label
            htmlFor="negative-checks"
            className="text-xs text-muted-foreground cursor-pointer"
          >
            Run negative OAuth checks
          </label>
          <Switch
            id="negative-checks"
            checked={negativeChecks}
            onCheckedChange={setNegativeChecks}
            className="scale-75"
            disabled={isRunning}
          />
        </div>
      </div>

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
      </div>

      <div className="mt-4 space-y-4 overflow-y-auto pr-1">
        <SuiteSection title="Protocol" state={protocol}>
          {protocol.report ? (
            <div>
              {protocol.report.groups.map((group) => (
                <div key={`${runVersion}-${group.id}`}>
                  {protocol.report.groups.length > 1 ? (
                    <div className="px-1 pt-1 text-xs font-medium text-foreground/80">
                      {group.title}
                    </div>
                  ) : null}
                  {group.summary ? (
                    <div className="px-1 py-1 text-[10px] text-muted-foreground">
                      {group.summary}
                    </div>
                  ) : null}
                  {group.cases.map((reportCase) => (
                    <ReportCaseRow
                      key={`${runVersion}-${group.id}-${reportCase.id}`}
                      reportCase={reportCase}
                    />
                  ))}
                </div>
              ))}
            </div>
          ) : null}
        </SuiteSection>

        <SuiteSection title="Apps" state={apps}>
          {apps.report ? (
            <div>
              {apps.report.groups.map((group) => (
                <div key={`${runVersion}-${group.id}`}>
                  {apps.report.groups.length > 1 ? (
                    <div className="px-1 pt-1 text-xs font-medium text-foreground/80">
                      {group.title}
                    </div>
                  ) : null}
                  {group.summary ? (
                    <div className="px-1 py-1 text-[10px] text-muted-foreground">
                      {group.summary}
                    </div>
                  ) : null}
                  {group.cases.map((reportCase) => (
                    <ReportCaseRow
                      key={`${runVersion}-${group.id}-${reportCase.id}`}
                      reportCase={reportCase}
                    />
                  ))}
                </div>
              ))}
            </div>
          ) : null}
        </SuiteSection>

        <SuiteSection title="OAuth" state={oauth}>
          {oauth.waitingForAuth ? (
            <div className="flex items-center gap-2 px-1 py-3 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Waiting for browser authorization...
            </div>
          ) : oauth.report ? (
            <div>
              {oauth.report.groups.map((group) => (
                <div key={`${runVersion}-${group.id}`}>
                  {oauth.report.groups.length > 1 ? (
                    <div className="px-1 pt-1 text-xs font-medium text-foreground/80">
                      {group.title}
                    </div>
                  ) : null}
                  {group.summary ? (
                    <div className="px-1 py-1 text-[10px] text-muted-foreground">
                      {group.summary}
                    </div>
                  ) : null}
                  {group.cases.map((reportCase) => (
                    <ReportCaseRow
                      key={`${runVersion}-${group.id}-${reportCase.id}`}
                      reportCase={reportCase}
                    />
                  ))}
                </div>
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
  // and/or missing config while the workspace is still hydrating — treat any
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
