import { runTaskConformanceGroups } from "./run-task-conformance-groups";
/** Run state, scores, and OAuth authorization for the four conformance suites. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// Browser-safe SDK entry — the top-level `@mcpjam/sdk` pulls Node-only
// transitive deps that break the Vite browser bundle.
import {
  type McpProtocolVersion,
  type MCPOAuthReadinessId,
  pooledConformanceScore,
  scoreFromAppsResult,
  scorableOAuthIds,
  scoreFromOAuthResult,
  scoreFromProtocolResult,
  scoreFromTasksResult,
  type ConformanceScore,
} from "@mcpjam/sdk/browser";
import type { ServerWithName } from "@/hooks/use-app-state";
import {
  completeOAuthConformance,
  runAppsConformance,
  runProtocolConformance,
  startOAuthConformance,
  submitOAuthConformanceCode,
} from "@/lib/apis/mcp-conformance-api";
import { deriveOAuthProfileFromServer } from "@/components/oauth/utils";
import {
  protocolRunOptions,
  tasksRunOptions,
  type ConformanceProbes,
} from "@/hooks/use-conformance-probes";
import {
  conformanceTargetKey,
  useConformanceRunVersion,
} from "./use-conformance-run-version";
import {
  createAppsState,
  createOAuthState,
  createProtocolState,
  createTasksState,
  isHttpServer,
  isSelected,
  NOT_SELECTED,
  oauthStateFromResult,
  runnableSelection,
  suiteErrorMessage,
  verdictOf,
  type AppsSuiteState,
  type ConformanceSelection,
  type OAuthSuiteState,
  type ProtocolSuiteState,
  type ProtocolVersionPin,
  type TasksSuiteState,
} from "@/hooks/conformance-suite-state";
import {
  assertSavedSecretTargets,
  loadSavedClientSecret,
  oauthTargetUrl,
} from "@/lib/oauth/saved-client-secret";

/**
 * The authorization URL comes from the target's own metadata. A `javascript:`
 * or `data:` URL handed to `window.open` runs in this origin, so only web
 * URLs are opened; plain `http:` stays allowed for local authorization servers.
 */
function isWebUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** The OAuth popup, or null when the browser blocked it. */
function openAuthorizationPopup(authorizationUrl: string): Window | null {
  return window.open(
    authorizationUrl,
    "oauth_conformance_auth",
    "width=600,height=700,scrollbars=yes"
  );
}

export {
  createAppsState,
  createOAuthState,
  createProtocolState,
  createTasksState,
  isHttpServer,
  oauthStateFromResult,
  runnableSelection,
};
export type {
  AppsSuiteState,
  ConformanceSelection,
  OAuthSuiteState,
  ProtocolSuiteState,
  ProtocolVersionPin,
  SuiteState,
  SuiteStatus,
  TasksSuiteState,
} from "@/hooks/conformance-suite-state";

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
  /** The revision the first run tests against, e.g. one picked before Run. */
  initialVersionPin?: ProtocolVersionPin;
  initialResolvedProtocolVersion?: McpProtocolVersion;
  /** What to run, as picked before Run. Absent ⇒ every check of every suite. */
  selection?: ConformanceSelection;
  /**
   * Tools named as safe for the checks that must call one, as set in the
   * check list. Absent ⇒ nothing on the server is executed, and those checks
   * report could-not-run.
   */
  probes?: ConformanceProbes;
}

export interface UseConformanceRunResult {
  protocol: ProtocolSuiteState;
  apps: AppsSuiteState;
  tasks: TasksSuiteState;
  oauth: OAuthSuiteState;
  versionPin: ProtocolVersionPin;
  resolvedProtocolVersion?: McpProtocolVersion;
  setVersionPin: (pin: ProtocolVersionPin) => void;
  /** Bumped on every fresh run — a render key for per-suite disclosure state. */
  runVersion: number;
  runAll: () => Promise<void>;
  /** Open the parked OAuth authorization popup. No-op unless parked. */
  authorizeOAuth: () => void;
  /**
   * Open the authorization page again for a suite waiting on the browser.
   * Called from a click, so a popup blocker lets it through.
   */
  openAuthorizationWindow: () => void;
  /** Stop waiting for OAuth authorization; the suite is left not scored. */
  skipOAuth: () => void;
  protocolScore?: ConformanceScore;
  appsScore?: ConformanceScore;
  tasksScore?: ConformanceScore;
  oauthScore?: ConformanceScore;
  pooledScore?: ConformanceScore;
  /**
   * The OAuth steps this run leaves out of its score, as picked when it
   * started: they ran, and read as unscored.
   */
  oauthUnscored: readonly string[];
  /** True when OAuth produced a score object with nothing applicable in it. */
  oauthNotScored: boolean;
  isRunning: boolean;
}

export function useConformanceRun({
  server,
  deferOAuthAuthorization = false,
  initialVersionPin = "auto",
  initialResolvedProtocolVersion,
  selection,
  probes,
}: UseConformanceRunOptions): UseConformanceRunResult {
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
  const [versionPin, setVersionPin] =
    useState<ProtocolVersionPin>(initialVersionPin);
  const resolveVersion = useConformanceRunVersion(
    server,
    initialVersionPin,
    initialResolvedProtocolVersion,
  );
  const [resolvedProtocolVersion, setResolvedProtocolVersion] =
    useState<McpProtocolVersion>();
  // Read when a run starts; the caller passes it once, before Run.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  // Read when the protocol suite starts, like the selection.
  const probesRef = useRef(probes);
  probesRef.current = probes;
  const [oauthUnscored, setOAuthUnscored] = useState<readonly string[]>([]);
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
    [],
  );

  /** The run whose OAuth suite the visitor skipped, if any. */
  const skippedOAuthRunTokenRef = useRef<number | null>(null);

  // A skip ends only the OAuth suite, so it cannot bump the run token the
  // other suites report under. A callback already past its listener checks
  // this instead, or it would overwrite the skip with a late result.
  const isOAuthRunActive = useCallback(
    (runToken: number, serverName: string) =>
      isRunActive(runToken, serverName) &&
      skippedOAuthRunTokenRef.current !== runToken,
    [isRunActive],
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
      setResolvedProtocolVersion(undefined);
      setRunVersion((value) => value + 1);
      setProtocol(createProtocolState(currentServer));
      setApps(createAppsState(currentServer));
      setTasks(createTasksState(currentServer));
      setOAuth(createOAuthState(currentServer));
      activeServerNameRef.current = effectiveServerName;
    },
    [clearOAuthListeners],
  );

  const serverConfigKey = useMemo(
    () => conformanceTargetKey(server),
    [server.name, server.config],
  );

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
    [clearOAuthListeners],
  );

  const runProtocol = useCallback(
    async (
      runToken: number,
      serverName: string,
      options: Parameters<typeof runProtocolConformance>[1],
    ) => {
      if (!httpServer) return;
      setProtocol({ status: "running" });
      try {
        const { result } = await runProtocolConformance(serverName, options);
        if (!isRunActive(runToken, serverName)) return;
        setProtocol({ status: "done", result, verdict: verdictOf(result) });
      } catch (err) {
        if (!isRunActive(runToken, serverName)) return;
        setProtocol({ status: "error", error: suiteErrorMessage(err) });
      }
    },
    [httpServer, isRunActive],
  );

  const runApps = useCallback(
    async (
      runToken: number,
      serverName: string,
      options: Parameters<typeof runAppsConformance>[1],
    ) => {
      setApps({ status: "running" });
      try {
        const { result } = await runAppsConformance(serverName, options);
        if (!isRunActive(runToken, serverName)) return;
        setApps({ status: "done", result, verdict: verdictOf(result) });
      } catch (err) {
        if (!isRunActive(runToken, serverName)) return;
        setApps({ status: "error", error: suiteErrorMessage(err) });
      }
    },
    [isRunActive],
  );

  const runTasks = useCallback(
    async (
      runToken: number,
      serverName: string,
      options: Parameters<typeof runTaskConformanceGroups>[1],
    ) => {
      setTasks({ status: "running" });
      try {
        const result = await runTaskConformanceGroups(serverName, options, () =>
          isRunActive(runToken, serverName),
        );
        if (!result) return;
        setTasks({ status: "done", result, verdict: verdictOf(result) });
      } catch (err) {
        if (!isRunActive(runToken, serverName)) return;
        setTasks({ status: "error", error: suiteErrorMessage(err) });
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
          if (!isOAuthRunActive(runToken, serverName)) return;
          if (poll.phase === "complete" && poll.result) {
            setOAuth(oauthStateFromResult(poll.result));
            return;
          }
        } catch (err) {
          if (!isOAuthRunActive(runToken, serverName)) return;
          setOAuth({
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }
      }

      if (!isOAuthRunActive(runToken, serverName)) return;
      setOAuth({
        status: "error",
        error:
          "The OAuth checks took too long to finish. Run the checks again.",
      });
    },
    [isOAuthRunActive],
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
        if (!isOAuthRunActive(runToken, serverName)) return;
        setOAuth((prev) => ({
          ...prev,
          waitingForAuth: false,
          status: "running",
        }));
        await pollOAuthComplete(sessionId, runToken, serverName);
      } catch (err) {
        if (!isOAuthRunActive(runToken, serverName)) return;
        setOAuth({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [isOAuthRunActive, pollOAuthComplete],
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
      serverName: string,
    ) => {
      if (!isWebUrl(authorizationUrl)) {
        setOAuth({
          status: "error",
          error:
            "This server's authorization URL is not an http or https address, so it was not opened. Fix the authorization URL in its OAuth metadata, then run again.",
        });
        return;
      }
      const popup = openAuthorizationPopup(authorizationUrl);
      setOAuth({
        status: "running",
        sessionId,
        waitingForAuth: true,
        authorizationUrl,
        popupBlocked: !popup,
      });

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
          data.state,
        );
      };

      const handleMessage = (event: MessageEvent) => {
        // The callback page posts to window.location.origin, so anything from
        // elsewhere is a foreign window injecting an authorization code.
        if (event.origin !== window.location.origin) return;
        if (event.data?.type !== "OAUTH_CALLBACK" || !event.data?.code) return;
        onCode(event.data);
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
          onCode(event.data);
        };
        cleanupFns.push(() => channel.close());
      } catch {
        // BroadcastChannel not available
      }
    },
    [handleOAuthCallback],
  );

  const runOAuth = useCallback(
    async (
      runToken: number,
      currentServer: ServerWithName,
      protocolVersion: McpProtocolVersion,
      readinessIds?: MCPOAuthReadinessId[],
    ) => {
      if (!isHttpServer(currentServer)) return;

      const serverName = currentServer.name;
      setOAuth({ status: "running" });

      try {
        const profile = deriveOAuthProfileFromServer(currentServer);
        // Always send callbackOrigin — both local and hosted modes redirect
        // back to the inspector's own `/oauth/callback/debug` page so the
        // server can surface the code back to the SDK runner.
        const callbackOrigin = window.location.origin;

        const saved =
          profile.clientSecret || !profile.clientId
            ? undefined
            : await loadSavedClientSecret(currentServer);
        if (!isRunActive(runToken, serverName)) return;
        if (saved) assertSavedSecretTargets(serverName, saved);
        const serverUrl = oauthTargetUrl(currentServer, profile.serverUrl);
        const baseProfile = serverUrl
          ? {
              serverUrl,
              registrationStrategy: profile.registrationStrategy,
              clientId: profile.clientId || undefined,
              clientSecret: profile.clientSecret || saved?.clientSecret,
              scopes: profile.scopes || undefined,
              customHeaders: profile.customHeaders.length
                ? profile.customHeaders
                : undefined,
            }
          : undefined;

        const startResult = await startOAuthConformance({
          serverNameOrId: serverName,
          oauthProfile: { ...baseProfile, protocolVersion },
          callbackOrigin,
          readinessIds,
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
            serverName,
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
    [beginOAuthAuthorization, deferOAuthAuthorization, isRunActive],
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
      pending.serverName,
    );
  }, [beginOAuthAuthorization, isRunActive]);

  const openAuthorizationWindow = useCallback(() => {
    if (!oauth.waitingForAuth || !oauth.authorizationUrl) return;
    const popup = openAuthorizationPopup(oauth.authorizationUrl);
    setOAuth((prev) =>
      prev.waitingForAuth ? { ...prev, popupBlocked: !popup } : prev,
    );
  }, [oauth.authorizationUrl, oauth.waitingForAuth]);

  // The listeners for the code stay unwired after a skip, so a consent that
  // completes late in another tab cannot resurrect the suite.
  const skipOAuth = useCallback(() => {
    skippedOAuthRunTokenRef.current = latestRunTokenRef.current;
    pendingOAuthRef.current = null;
    clearOAuthListeners();
    setOAuth({
      status: "unavailable",
      unavailableReason: "OAuth was skipped, so it is not scored for this run.",
      skipped: true,
    });
  }, [clearOAuthListeners]);

  const runAll = useCallback(async () => {
    const runToken = beginRun();
    const currentServer = server;
    const httpServerNow = isHttpServer(currentServer);

    const selection = selectionRef.current;
    const probes = probesRef.current ?? {};
    const selected = runnableSelection(selection, versionPin);
    setOAuthUnscored(scorableOAuthIds(selected?.oauthUnscored));
    setRunVersion((value) => value + 1);
    setResolvedProtocolVersion(undefined);
    setProtocol(
      httpServerNow
        ? isSelected(selected?.protocol)
          ? { status: "running" }
          : NOT_SELECTED
        : createProtocolState(currentServer),
    );
    setApps(isSelected(selected?.apps) ? { status: "running" } : NOT_SELECTED);
    setTasks(
      isSelected(selected?.tasks) ? { status: "running" } : NOT_SELECTED,
    );
    setOAuth(
      httpServerNow
        ? selected?.oauth !== false
          ? { status: "running" }
          : NOT_SELECTED
        : createOAuthState(currentServer),
    );
    let resolved: McpProtocolVersion | undefined;
    try {
      resolved = await resolveVersion(currentServer, versionPin);
    } catch (error) {
      if (!isRunActive(runToken, currentServer.name)) return;
      const state = {
        status: "error" as const,
        error: suiteErrorMessage(error),
      };
      if (httpServerNow && isSelected(selected?.protocol)) setProtocol(state);
      if (isSelected(selected?.apps)) setApps(state);
      if (isSelected(selected?.tasks)) setTasks(state);
      if (httpServerNow && selected?.oauth !== false) setOAuth(state);
      return;
    }
    if (!isRunActive(runToken, currentServer.name)) return;
    setResolvedProtocolVersion(resolved);
    const pin = resolved ?? versionPin;
    const picked = runnableSelection(selection, pin);
    setOAuthUnscored(scorableOAuthIds(picked?.oauthUnscored));
    const promises: Promise<void>[] = [];
    if (httpServerNow) {
      if (isSelected(picked?.protocol)) {
        promises.push(
          runProtocol(
            runToken,
            currentServer.name,
            protocolRunOptions(probes, picked, pin),
          ),
        );
      } else {
        setProtocol(NOT_SELECTED);
      }
    }
    if (isSelected(picked?.apps)) {
      promises.push(
        runApps(runToken, currentServer.name, {
          checkIds: picked?.apps,
          protocolVersion: resolved,
        }),
      );
    } else {
      setApps(NOT_SELECTED);
    }
    if (isSelected(picked?.tasks)) {
      promises.push(
        runTasks(runToken, currentServer.name, {
          ...tasksRunOptions(probes, picked),
          protocolVersion: resolved,
        }),
      );
    } else {
      setTasks(NOT_SELECTED);
    }
    if (httpServerNow) {
      if (picked?.oauth !== false && resolved) {
        promises.push(
          runOAuth(runToken, currentServer, resolved, picked?.oauthAdvice),
        );
      } else {
        setOAuth(NOT_SELECTED);
      }
    }

    await Promise.allSettled(promises);
  }, [
    beginRun,
    isRunActive,
    resolveVersion,
    runApps,
    runOAuth,
    runProtocol,
    runTasks,
    server,
    versionPin,
  ]);

  // Scores are derived, never stored: each finished suite contributes, and
  // the headline pools their COUNTS (not an average of suite scores), so a
  // 0-for-9 OAuth run stays visible inside 30 protocol passes.
  const protocolScore = useMemo(
    () =>
      protocol.result ? scoreFromProtocolResult(protocol.result) : undefined,
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
    () =>
      oauth.result
        ? scoreFromOAuthResult(oauth.result, {
            unscoredCheckIds: oauthUnscored,
          })
        : undefined,
    [oauth.result, oauthUnscored],
  );
  // The suite's badge follows its score once steps are left out of it: a
  // failure in an unscored step must not read FAILED beside a passing score.
  // A not-applicable flow is "unavailable" and keeps its own treatment.
  const oauthShown = useMemo<OAuthSuiteState>(
    () =>
      oauth.status === "done" && oauthUnscored.length > 0 && oauthScore
        ? { ...oauth, verdict: oauthScore.outcome }
        : oauth,
    [oauth, oauthUnscored, oauthScore],
  );
  const pooledScore = useMemo(() => {
    const parts = [protocolScore, appsScore, tasksScore, oauthScore].filter(
      (part): part is ConformanceScore => part !== undefined,
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
    oauth: oauthShown,
    versionPin,
    resolvedProtocolVersion,
    setVersionPin,
    runVersion,
    runAll,
    authorizeOAuth,
    openAuthorizationWindow,
    skipOAuth,
    protocolScore,
    appsScore,
    tasksScore,
    oauthScore,
    pooledScore,
    oauthUnscored,
    oauthNotScored: oauthScore !== undefined && oauthScore.score === null,
    isRunning,
  };
}
