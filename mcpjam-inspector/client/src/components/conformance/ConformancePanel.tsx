import { useState, useCallback } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  CheckCircle2,
  XCircle,
  MinusCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
} from "lucide-react";
import type { ServerWithName } from "@/hooks/use-app-state";
import type {
  MCPConformanceResult,
  MCPAppsConformanceResult,
  MCPCheckResult,
  MCPAppsCheckResult,
  OAuthConformanceStepResult,
} from "@mcpjam/sdk";
import type { OAuthConformanceStartResult } from "@/lib/apis/mcp-conformance-api";
import {
  runProtocolConformance,
  runAppsConformance,
  startOAuthConformance,
  submitOAuthConformanceCode,
  completeOAuthConformance,
} from "@/lib/apis/mcp-conformance-api";
import { deriveOAuthProfileFromServer } from "@/components/oauth/utils";
import { isHostedMode } from "@/lib/apis/mode-client";

// ── Types ───────────────────────────────────────────────────────────────

type SuiteStatus = "idle" | "running" | "done" | "error" | "unavailable";

interface SuiteState {
  status: SuiteStatus;
  error?: string;
  unavailableReason?: string;
}

interface ProtocolSuiteState extends SuiteState {
  result?: MCPConformanceResult;
}

interface AppsSuiteState extends SuiteState {
  result?: MCPAppsConformanceResult;
}

interface OAuthSuiteState extends SuiteState {
  result?: OAuthConformanceStartResult["result"];
  sessionId?: string;
  authorizationUrl?: string;
  waitingForAuth?: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function isHttpServer(server: ServerWithName): boolean {
  return "url" in server.config;
}

function StatusIcon({ status }: { status: string }) {
  if (status === "passed")
    return (
      <CheckCircle2 className="h-3.5 w-3.5 text-green-500 flex-shrink-0" />
    );
  if (status === "failed")
    return <XCircle className="h-3.5 w-3.5 text-red-500 flex-shrink-0" />;
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

function CheckRow({ check }: { check: MCPCheckResult | MCPAppsCheckResult }) {
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
    if (state.status === "running")
      return (
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Running
        </span>
      );
    if (state.status === "unavailable")
      return (
        <span className="text-[10px] text-muted-foreground">Unavailable</span>
      );
    if (state.status === "error")
      return <span className="text-[10px] text-red-400">Error</span>;
    if (state.status === "done")
      return <span className="text-[10px] text-green-500">Done</span>;
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

// ── ConformancePanel ────────────────────────────────────────────────────

interface ConformancePanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  server: ServerWithName;
}

export function ConformancePanel({
  open,
  onOpenChange,
  server,
}: ConformancePanelProps) {
  const httpServer = isHttpServer(server);

  const [protocol, setProtocol] = useState<ProtocolSuiteState>({
    status: httpServer ? "idle" : "unavailable",
    unavailableReason: httpServer
      ? undefined
      : "Protocol conformance requires HTTP transport",
  });
  const [apps, setApps] = useState<AppsSuiteState>({ status: "idle" });
  const [oauth, setOAuth] = useState<OAuthSuiteState>({
    status: httpServer ? "idle" : "unavailable",
    unavailableReason: httpServer
      ? undefined
      : "OAuth conformance requires HTTP transport",
  });
  const [negativeChecks, setNegativeChecks] = useState(false);
  const [runVersion, setRunVersion] = useState(0);

  const resetStates = useCallback(() => {
    setRunVersion((value) => value + 1);
    setProtocol({
      status: httpServer ? "idle" : "unavailable",
      unavailableReason: httpServer
        ? undefined
        : "Protocol conformance requires HTTP transport",
    });
    setApps({ status: "idle" });
    setOAuth({
      status: httpServer ? "idle" : "unavailable",
      unavailableReason: httpServer
        ? undefined
        : "OAuth conformance requires HTTP transport",
    });
  }, [httpServer]);

  const runProtocol = useCallback(async () => {
    if (!httpServer) return;
    setProtocol({ status: "running" });
    try {
      const { result } = await runProtocolConformance(server.name);
      setProtocol({ status: "done", result });
    } catch (err) {
      setProtocol({
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [server.name, httpServer]);

  const runApps = useCallback(async () => {
    setApps({ status: "running" });
    try {
      const { result } = await runAppsConformance(server.name);
      setApps({ status: "done", result });
    } catch (err) {
      setApps({
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [server.name]);

  const pollOAuthComplete = useCallback(async (sessionId: string) => {
    const MAX_POLLS = 10;
    for (let i = 0; i < MAX_POLLS; i++) {
      try {
        const poll = await completeOAuthConformance(sessionId);
        if (poll.phase === "complete" && poll.result) {
          setOAuth({ status: "done", result: poll.result });
          return;
        }
        // Still pending: keep polling
      } catch (err) {
        setOAuth({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    }
    setOAuth({ status: "error", error: "OAuth conformance timed out" });
  }, []);

  const handleOAuthCallback = useCallback(
    async (sessionId: string, code: string, state?: string) => {
      try {
        await submitOAuthConformanceCode({ sessionId, code, state });
        setOAuth((prev) => ({
          ...prev,
          waitingForAuth: false,
          status: "running",
        }));
        await pollOAuthComplete(sessionId);
      } catch (err) {
        setOAuth({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [pollOAuthComplete],
  );

  const runOAuth = useCallback(async () => {
    if (!httpServer) return;
    setOAuth({ status: "running" });

    try {
      const profile = deriveOAuthProfileFromServer(server);
      const callbackOrigin = isHostedMode()
        ? window.location.origin
        : undefined;

      const startResult = await startOAuthConformance({
        serverNameOrId: server.name,
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

      if (startResult.phase === "complete" && startResult.result) {
        setOAuth({ status: "done", result: startResult.result });
        return;
      }

      if (
        startResult.phase === "authorization_needed" &&
        startResult.sessionId &&
        startResult.authorizationUrl
      ) {
        const sessionId = startResult.sessionId;
        const authUrl = startResult.authorizationUrl;

        setOAuth({
          status: "running",
          sessionId,
          authorizationUrl: authUrl,
          waitingForAuth: true,
        });

        // Open popup for authorization
        const popup = window.open(
          authUrl,
          "oauth_conformance_auth",
          "width=600,height=700,scrollbars=yes",
        );

        // Listen for callback via BroadcastChannel or postMessage
        const handleMessage = (event: MessageEvent) => {
          if (event.data?.type === "OAUTH_CALLBACK" && event.data?.code) {
            window.removeEventListener("message", handleMessage);
            channel?.close();
            void handleOAuthCallback(
              sessionId,
              event.data.code,
              event.data.state,
            );
          }
        };

        window.addEventListener("message", handleMessage);

        // Also listen via BroadcastChannel
        let channel: BroadcastChannel | undefined;
        try {
          channel = new BroadcastChannel("oauth_callback_channel");
          channel.onmessage = (event) => {
            if (event.data?.type === "OAUTH_CALLBACK" && event.data?.code) {
              window.removeEventListener("message", handleMessage);
              channel?.close();
              void handleOAuthCallback(
                sessionId,
                event.data.code,
                event.data.state,
              );
            }
          };
        } catch {
          // BroadcastChannel not available
        }

        // For local mode: the loopback callback handles it. Poll for completion.
        if (!isHostedMode()) {
          await pollOAuthComplete(sessionId);
        }

        return;
      }
    } catch (err) {
      setOAuth({
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [
    server,
    httpServer,
    negativeChecks,
    handleOAuthCallback,
    pollOAuthComplete,
  ]);

  const runAll = useCallback(async () => {
    resetStates();

    const promises: Promise<void>[] = [];

    // Protocol and Apps in parallel
    if (httpServer) {
      promises.push(runProtocol());
    }
    promises.push(runApps());

    // OAuth in parallel when eligible
    if (httpServer) {
      promises.push(runOAuth());
    }

    await Promise.allSettled(promises);
  }, [httpServer, runProtocol, runApps, runOAuth, resetStates]);

  const isRunning =
    protocol.status === "running" ||
    apps.status === "running" ||
    oauth.status === "running";

  const renderProtocolChecks = () => {
    if (!protocol.result) return null;
    return (
      <div>
        <div className="px-1 py-1 text-[10px] text-muted-foreground">
          {protocol.result.summary}
        </div>
        {protocol.result.checks.map((check) => (
          <CheckRow key={`${runVersion}-${check.id}`} check={check} />
        ))}
      </div>
    );
  };

  const renderAppsChecks = () => {
    if (!apps.result) return null;
    return (
      <div>
        <div className="px-1 py-1 text-[10px] text-muted-foreground">
          {apps.result.summary}
        </div>
        {apps.result.checks.map((check) => (
          <CheckRow key={`${runVersion}-${check.id}`} check={check} />
        ))}
      </div>
    );
  };

  const renderOAuthSteps = () => {
    if (oauth.waitingForAuth) {
      return (
        <div className="flex items-center gap-2 px-1 py-3 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Waiting for browser authorization...
        </div>
      );
    }
    if (!oauth.result) return null;
    return (
      <div>
        <div className="px-1 py-1 text-[10px] text-muted-foreground">
          {oauth.result.summary}
        </div>
        {oauth.result.steps.map((step: OAuthConformanceStepResult) => (
          <OAuthStepRow key={`${runVersion}-${step.step}`} step={step} />
        ))}
      </div>
    );
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[480px] sm:max-w-[480px] overflow-y-auto"
      >
        <SheetHeader className="pb-4">
          <SheetTitle>Conformance</SheetTitle>
          <SheetDescription className="text-xs">
            Run Protocol, Apps, and OAuth checks against {server.name}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4">
          {/* Controls */}
          <div className="flex items-center justify-between gap-2">
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

          {/* Protocol Suite */}
          <SuiteSection title="Protocol" state={protocol}>
            {renderProtocolChecks()}
          </SuiteSection>

          {/* Apps Suite */}
          <SuiteSection title="Apps" state={apps}>
            {renderAppsChecks()}
          </SuiteSection>

          {/* OAuth Suite */}
          <SuiteSection title="OAuth" state={oauth}>
            {renderOAuthSteps()}
          </SuiteSection>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── OAuth Step Row ──────────────────────────────────────────────────────

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
