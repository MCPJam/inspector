/**
 * One conformance run — all four suites, their per-suite scores, and the
 * pooled headline — as a hook.
 *
 * This logic grew up inside `ConformancePanel` and now has a second consumer
 * (the score.mcpjam.com surface). Two copies would drift on exactly the parts
 * that must not: what "done" means per suite, which suites a transport can
 * run, and how the headline number is pooled. Rendering deliberately stays
 * with the panel — this hook owns run state and nothing visual.
 *
 * Two OAuth flows exist in this codebase and they are NOT the same thing:
 *
 *   - The OAuth *conformance suite* (here) re-runs discovery/DCR/PKCE against
 *     the target in order to GRADE it, and drives its own popup +
 *     postMessage/BroadcastChannel callback.
 *   - Connect-OAuth (`use-hosted-oauth-gate`) authorizes a connection so the
 *     other three suites can run at all, via a full-page redirect.
 *
 * Only the first lives here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  MCPConformanceResult,
  MCPAppsConformanceResult,
  MCPTasksConformanceResult,
} from "@mcpjam/sdk";
// Browser-safe SDK entry — the top-level `@mcpjam/sdk` pulls Node-only
// transitive deps that break the Vite browser bundle.
import {
  canRunConformance,
  pooledConformanceScore,
  scoreFromAppsResult,
  scoreFromOAuthResult,
  scoreFromProtocolResult,
  scoreFromTasksResult,
  type ConformanceScore,
  type McpProtocolVersion,
} from "@mcpjam/sdk/browser";
import type { ServerWithName } from "@/hooks/use-app-state";
import type { OAuthConformanceStartResult } from "@/lib/apis/mcp-conformance-api";
import {
  completeOAuthConformance,
  runAppsConformance,
  runProtocolConformance,
  runTasksConformance,
  startOAuthConformance,
  submitOAuthConformanceCode,
} from "@/lib/apis/mcp-conformance-api";
import { deriveOAuthProfileFromServer } from "@/components/oauth/utils";

export type SuiteStatus =
  | "idle"
  | "running"
  /**
   * The OAuth suite reached the authorization step and is holding: it has a
   * session and a URL, and is waiting for an explicit go-ahead. Only reachable
   * under `deferOAuthAuthorization`.
   */
  | "needs-authorization"
  | "done"
  | "error"
  | "unavailable";

/** "auto" ⇒ no pin: the run adopts whatever version the server negotiates. */
export type ProtocolVersionPin = "auto" | McpProtocolVersion;

export interface SuiteState {
  status: SuiteStatus;
  error?: string;
  unavailableReason?: string;
  /**
   * The verdict of a finished run. "Done" only says the run ended — a suite
   * that finished with failures must not read as green.
   */
  verdict?: "passed" | "failed" | "incomplete";
}

export interface ProtocolSuiteState extends SuiteState {
  result?: MCPConformanceResult;
}

export interface AppsSuiteState extends SuiteState {
  result?: MCPAppsConformanceResult;
}

export interface TasksSuiteState extends SuiteState {
  result?: MCPTasksConformanceResult;
}

export interface OAuthSuiteState extends SuiteState {
  result?: OAuthConformanceStartResult["result"];
  sessionId?: string;
  waitingForAuth?: boolean;
  /**
   * Set only while `status === "needs-authorization"`: the URL the explicit
   * authorize step will open.
   */
  authorizationUrl?: string;
}

export function isHttpServer(server: ServerWithName): boolean {
  // `server.config` is typed required but can be undefined during hosted
  // hydration — guard before using the `in` operator to avoid a TypeError.
  return !!server.config && "url" in server.config;
}

function suiteState(
  suite: "protocol" | "oauth" | "apps" | "tasks",
  server: ServerWithName
): SuiteState {
  // The SDK's `canRunConformance` is the source of truth for which suites
  // support which transports. It handles null/undefined configs gracefully.
  const support = canRunConformance(
    suite,
    server.config as Parameters<typeof canRunConformance>[1]
  );
  return support.supported
    ? { status: "idle" }
    : { status: "unavailable", unavailableReason: support.reason };
}

export function createProtocolState(
  server: ServerWithName
): ProtocolSuiteState {
  return suiteState("protocol", server);
}

export function createAppsState(server: ServerWithName): AppsSuiteState {
  return suiteState("apps", server);
}

export function createTasksState(server: ServerWithName): TasksSuiteState {
  return suiteState("tasks", server);
}

export function createOAuthState(server: ServerWithName): OAuthSuiteState {
  return suiteState("oauth", server);
}

/** Every suite reports the same three-value outcome; render it, don't flatten it. */
function verdictOf(result: {
  outcome?: string;
  passed?: boolean;
}): "passed" | "failed" | "incomplete" {
  if (result.outcome === "incomplete") return "incomplete";
  return result.passed ? "passed" : "failed";
}

/**
 * A server that requires no authorization has no OAuth obligations to test —
 * authorization is OPTIONAL in every MCP revision — so the suite reports
 * `not-applicable`. That is not a result to render as red: it reuses the same
 * "unavailable" treatment as a transport that cannot run the suite.
 */
export function oauthStateFromResult(
  result: NonNullable<OAuthConformanceStartResult["result"]>
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
    // OAuth reports the same three-value verdict as the other suites (plus its
    // own not-applicable, handled above), so an incomplete flow is badged
    // amber rather than flattened to failed.
    verdict: verdictOf(result),
  };
}

export interface UseConformanceRunOptions {
  server: ServerWithName;
  /**
   * When true, a run that reaches OAuth's authorization step PARKS at
   * `needs-authorization` instead of opening the popup, and the caller decides
   * when (or whether) to proceed via `authorizeOAuth`.
   *
   * The panel leaves this false: an operator who pressed "Run" in the product
   * asked for the whole run, popup included. The score page turns it on,
   * because an unrequested popup on a public landing page is a different
   * thing entirely — there, OAuth is an opt-in "authorize to include OAuth in
   * your score" step, and skipping it shows as *not scored*, never a
   * deduction.
   */
  deferOAuthAuthorization?: boolean;
}

export interface UseConformanceRunResult {
  protocol: ProtocolSuiteState;
  apps: AppsSuiteState;
  tasks: TasksSuiteState;
  oauth: OAuthSuiteState;
  versionPin: ProtocolVersionPin;
  setVersionPin: (pin: ProtocolVersionPin) => void;
  /** Bumped on every fresh run — a render key for per-suite disclosure state. */
  runVersion: number;
  runAll: () => Promise<void>;
  /** Open the parked OAuth authorization popup. No-op unless parked. */
  authorizeOAuth: () => void;
  protocolScore?: ConformanceScore;
  appsScore?: ConformanceScore;
  tasksScore?: ConformanceScore;
  oauthScore?: ConformanceScore;
  pooledScore?: ConformanceScore;
  /** True when OAuth produced a score object with nothing applicable in it. */
  oauthNotScored: boolean;
  isRunning: boolean;
}

export function useConformanceRun({
  server,
  deferOAuthAuthorization = false,
}: UseConformanceRunOptions): UseConformanceRunResult {
  const httpServer = isHttpServer(server);
  const [protocol, setProtocol] = useState<ProtocolSuiteState>(() =>
    createProtocolState(server)
  );
  const [apps, setApps] = useState<AppsSuiteState>(() =>
    createAppsState(server)
  );
  const [tasks, setTasks] = useState<TasksSuiteState>(() =>
    createTasksState(server)
  );
  const [oauth, setOAuth] = useState<OAuthSuiteState>(() =>
    createOAuthState(server)
  );
  const [versionPin, setVersionPin] = useState<ProtocolVersionPin>("auto");
  const [runVersion, setRunVersion] = useState(0);

  const activeServerNameRef = useRef(server.name);
  const latestRunTokenRef = useRef(0);
  const oauthListenerCleanupRef = useRef<(() => void) | null>(null);
  /** The parked authorization step, when `deferOAuthAuthorization` holds one. */
  const pendingOAuthRef = useRef<{
    sessionId: string;
    authorizationUrl: string;
    runToken: number;
    serverName: string;
  } | null>(null);

  const clearOAuthListeners = useCallback(() => {
    oauthListenerCleanupRef.current?.();
    oauthListenerCleanupRef.current = null;
  }, []);

  const beginRun = useCallback(() => {
    latestRunTokenRef.current += 1;
    pendingOAuthRef.current = null;
    clearOAuthListeners();
    return latestRunTokenRef.current;
  }, [clearOAuthListeners]);

  const isRunActive = useCallback(
    (runToken: number, serverName: string) =>
      latestRunTokenRef.current === runToken &&
      activeServerNameRef.current === serverName,
    []
  );

  /**
   * The current server, read without making the reset depend on its OBJECT
   * identity. `ServerWithName` carries mutable fields (`connectionStatus`,
   * `lastConnectionTime`), so hosted hydration and reconnect polling hand down
   * a fresh object for the same server mid-run. If `resetStates` changed
   * identity with it, the effect below would re-run and discard the results of
   * suites still in flight — the visitor would watch a finished run snap back
   * to idle for no visible reason. Only a change of NAME is a different server.
   */
  const serverRef = useRef(server);
  serverRef.current = server;

  const resetStates = useCallback(
    (serverName?: string) => {
      const effectiveServerName = serverName ?? activeServerNameRef.current;
      const currentServer = serverRef.current;
      latestRunTokenRef.current += 1;
      pendingOAuthRef.current = null;
      clearOAuthListeners();
      setRunVersion((value) => value + 1);
      setProtocol(createProtocolState(currentServer));
      setApps(createAppsState(currentServer));
      setTasks(createTasksState(currentServer));
      setOAuth(createOAuthState(currentServer));
      activeServerNameRef.current = effectiveServerName;
    },
    [clearOAuthListeners]
  );

  /**
   * A stable key for "which target is this". Name alone is not enough: editing
   * a server's URL or transport in place keeps the name and would leave the
   * previous target's results — and its score — on screen. The OBJECT identity
   * is too much (see `serverRef`); this is the middle ground that changes
   * exactly when the thing being graded changes.
   */
  const serverConfigKey = useMemo(() => {
    const config = server.config as
      | { url?: unknown; command?: unknown; args?: unknown }
      | undefined;
    return JSON.stringify([
      server.name,
      // Stringified, not type-narrowed: `url` is declared `string` but this
      // codebase also builds configs with a `URL` instance (see
      // `test/factories`). A `typeof === "string"` check maps every URL object
      // to null, so editing the URL would not change the key and the previous
      // target's score would stay on screen.
      config?.url != null ? String(config.url) : null,
      typeof config?.command === "string" ? config.command : null,
      Array.isArray(config?.args) ? config.args : null,
    ]);
  }, [server.name, server.config]);

  useEffect(() => {
    resetStates(server.name);
    // `serverConfigKey` is the trigger; `server.name` is read through it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverConfigKey, resetStates]);

  useEffect(
    () => () => {
      latestRunTokenRef.current += 1;
      clearOAuthListeners();
    },
    [clearOAuthListeners]
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
        setProtocol({ status: "done", result, verdict: verdictOf(result) });
      } catch (err) {
        if (!isRunActive(runToken, serverName)) return;
        setProtocol({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [httpServer, isRunActive, versionPin]
  );

  const runApps = useCallback(
    async (runToken: number, serverName: string) => {
      setApps({ status: "running" });
      try {
        const { result } = await runAppsConformance(serverName);
        if (!isRunActive(runToken, serverName)) return;
        setApps({ status: "done", result, verdict: verdictOf(result) });
      } catch (err) {
        if (!isRunActive(runToken, serverName)) return;
        setApps({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [isRunActive]
  );

  const runTasks = useCallback(
    async (runToken: number, serverName: string) => {
      setTasks({ status: "running" });
      try {
        const { result } = await runTasksConformance(serverName);
        if (!isRunActive(runToken, serverName)) return;
        // The tasks suite reports a real third outcome: checks that apply but
        // could not be exercised leave the run incomplete, never passing.
        setTasks({ status: "done", result, verdict: verdictOf(result) });
      } catch (err) {
        if (!isRunActive(runToken, serverName)) return;
        setTasks({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [isRunActive]
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
    [isRunActive]
  );

  const handleOAuthCallback = useCallback(
    async (
      sessionId: string,
      code: string,
      runToken: number,
      serverName: string,
      state?: string
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
    [isRunActive, pollOAuthComplete]
  );

  /**
   * Open the authorization popup and listen for the code coming back.
   *
   * Both local and hosted modes deliver the code through `/oauth/authorize`,
   * so there is no polling here — `handleOAuthCallback` owns everything after
   * the code arrives. Two channels are wired because a popup opened
   * cross-origin may only be able to reach one of them.
   */
  const beginOAuthAuthorization = useCallback(
    (
      sessionId: string,
      authorizationUrl: string,
      runToken: number,
      serverName: string
    ) => {
      setOAuth({ status: "running", sessionId, waitingForAuth: true });

      window.open(
        authorizationUrl,
        "oauth_conformance_auth",
        "width=600,height=700,scrollbars=yes"
      );

      const cleanupFns: Array<() => void> = [];
      const cleanup = () => {
        for (const fn of cleanupFns) fn();
        if (oauthListenerCleanupRef.current === cleanup) {
          oauthListenerCleanupRef.current = null;
        }
      };
      oauthListenerCleanupRef.current = cleanup;

      const onCode = (data: { code: string; state?: string }) => {
        cleanup();
        void handleOAuthCallback(
          sessionId,
          data.code,
          runToken,
          serverName,
          data.state
        );
      };

      const handleMessage = (event: MessageEvent) => {
        if (event.data?.type !== "OAUTH_CALLBACK" || !event.data?.code) return;
        onCode(event.data);
      };

      window.addEventListener("message", handleMessage);
      cleanupFns.push(() =>
        window.removeEventListener("message", handleMessage)
      );

      try {
        const channel = new BroadcastChannel("oauth_callback_channel");
        channel.onmessage = (event) => {
          if (event.data?.type !== "OAUTH_CALLBACK" || !event.data?.code) {
            return;
          }
          onCode(event.data);
        };
        cleanupFns.push(() => channel.close());
      } catch {
        // BroadcastChannel not available
      }
    },
    [handleOAuthCallback]
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
          const { sessionId, authorizationUrl } = startResult;
          if (deferOAuthAuthorization) {
            pendingOAuthRef.current = {
              sessionId,
              authorizationUrl,
              runToken,
              serverName,
            };
            setOAuth({
              status: "needs-authorization",
              sessionId,
              authorizationUrl,
            });
            return;
          }
          beginOAuthAuthorization(
            sessionId,
            authorizationUrl,
            runToken,
            serverName
          );
        }
      } catch (err) {
        if (!isRunActive(runToken, currentServer.name)) return;
        setOAuth({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [beginOAuthAuthorization, deferOAuthAuthorization, isRunActive, versionPin]
  );

  const authorizeOAuth = useCallback(() => {
    const pending = pendingOAuthRef.current;
    if (!pending) return;
    if (!isRunActive(pending.runToken, pending.serverName)) return;
    pendingOAuthRef.current = null;
    beginOAuthAuthorization(
      pending.sessionId,
      pending.authorizationUrl,
      pending.runToken,
      pending.serverName
    );
  }, [beginOAuthAuthorization, isRunActive]);

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

  // Scores are derived, never stored: each finished suite contributes, and
  // the headline pools their COUNTS (not an average of suite scores), so a
  // 0-for-9 OAuth run stays visible inside 30 protocol passes.
  const protocolScore = useMemo(
    () =>
      protocol.result ? scoreFromProtocolResult(protocol.result) : undefined,
    [protocol.result]
  );
  const appsScore = useMemo(
    () => (apps.result ? scoreFromAppsResult(apps.result) : undefined),
    [apps.result]
  );
  const tasksScore = useMemo(
    () => (tasks.result ? scoreFromTasksResult(tasks.result) : undefined),
    [tasks.result]
  );
  const oauthScore = useMemo(
    () => (oauth.result ? scoreFromOAuthResult(oauth.result) : undefined),
    [oauth.result]
  );
  const pooledScore = useMemo(() => {
    const parts = [protocolScore, appsScore, tasksScore, oauthScore].filter(
      (part): part is ConformanceScore => part !== undefined
    );
    return parts.length > 0 ? pooledConformanceScore(parts) : undefined;
  }, [protocolScore, appsScore, tasksScore, oauthScore]);

  const isRunning =
    protocol.status === "running" ||
    apps.status === "running" ||
    tasks.status === "running" ||
    oauth.status === "running";

  return {
    protocol,
    apps,
    tasks,
    oauth,
    versionPin,
    setVersionPin,
    runVersion,
    runAll,
    authorizeOAuth,
    protocolScore,
    appsScore,
    tasksScore,
    oauthScore,
    pooledScore,
    oauthNotScored: oauthScore !== undefined && oauthScore.score === null,
    isRunning,
  };
}
