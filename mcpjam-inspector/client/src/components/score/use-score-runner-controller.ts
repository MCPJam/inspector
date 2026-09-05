import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppReady, useAppReadyMessage } from "@/hooks/use-app-ready";
import { useConformanceRun } from "@/hooks/use-conformance-run";
import { useHostedOAuthGate } from "@/hooks/hosted/use-hosted-oauth-gate";
import { tryResolveProjectServer } from "@/lib/apis/web/context";
import { validateHostedServer } from "@/lib/apis/web/servers-api";
import { WebApiError } from "@/lib/apis/web/base";
import { SCORE_OAUTH_PENDING_KEY } from "@/lib/hosted-oauth-callback";
import { routePaths } from "@/lib/app-navigation";
import type { ServerWithName } from "@/state/app-types";
import {
  isScoreRunnerBusy,
  type ScoreRunnerPhase,
} from "./score-runner-view-model";
import {
  clearScoreRunResume,
  readScoreRunResume,
  writeScoreRunResume,
  type ScoreRunResumeRecord,
} from "./score-run-resume";
import type { ScoreRunIntent } from "./score-run-draft";
import { useScoreRunPersistence } from "./use-score-run-persistence";
import { useScoreServerPreparation } from "./use-score-server-preparation";
import {
  isScoreDesignWalkthrough,
  playScoreDesignWalkthrough,
  SCORE_PREVIEW_RESULT_TOKEN,
} from "./score-design-walkthrough";

const EMPTY_SERVER: ServerWithName = {
  name: "",
  config: {} as ServerWithName["config"],
  lastConnectionTime: new Date(0),
  connectionStatus: "disconnected",
  retryCount: 0,
};

function getServerUrl(server: ServerWithName | null): string | null {
  return (server?.config as { url?: string } | undefined)?.url ?? null;
}

/** `oauthRequired` is carried on a thrown, tagged 401 — never on a return value. */
function isOAuthRequiredError(error: unknown): boolean {
  return (
    error instanceof WebApiError &&
    (error.details as { oauthRequired?: unknown } | undefined)
      ?.oauthRequired === true
  );
}

export function useScoreRunnerController({
  convexProjectId,
}: {
  /** The guest's (or member's) project, from the app route context. */
  convexProjectId: string | null;
}) {
  const appReady = useAppReady();
  const appReadyMessage = useAppReadyMessage();

  const [phase, setPhase] = useState<ScoreRunnerPhase>("form");
  const [error, setError] = useState<string | null>(null);
  const [server, setServer] = useState<ServerWithName | null>(null);
  const [resultToken, setResultToken] = useState<string | null>(null);
  const [resumeRecord, setResumeRecord] = useState<ScoreRunResumeRecord | null>(
    null,
  );

  const run = useConformanceRun({
    // A placeholder keeps the hook's contract simple: it always has a server.
    // Nothing runs until `runAll` is called, and that only happens once a real
    // row exists.
    server: server ?? EMPTY_SERVER,
    // OAuth is opt-in here. A public landing page must not throw an
    // unrequested popup at a visitor, and a skipped OAuth suite shows as
    // *not scored* — never a deduction.
    deferOAuthAuthorization: true,
  });

  // Resolved through the public accessor rather than the module-level context
  // object: it returns null (instead of throwing BootstrapNotReadyError) while
  // bootstrap is still catching up, which is the normal state on this page for
  // the second or two after the row is created.
  const resolved = server ? tryResolveProjectServer(server.name) : null;
  const projectId = resolved?.projectId ?? convexProjectId;
  const serverId = resolved?.serverId;
  const prepareServer = useScoreServerPreparation(projectId);

  // Connect-OAuth (authorize the connection so protocol/apps/tasks can run at
  // all) is a DIFFERENT flow from the OAuth conformance suite above: it is a
  // full-page redirect, and it comes back through the "score" surface.
  // Memoized: the gate synchronizes state from `servers` in an effect, so a
  // fresh array every render would set state on every render and spin.
  const oauthDescriptors = useMemo(
    () =>
      server && serverId
        ? [
            {
              serverId,
              serverName: server.name,
              useOAuth: true,
              serverUrl: getServerUrl(server),
              clientId: null,
              oauthScopes: null,
            },
          ]
        : [],
    [server, serverId],
  );

  const oauthGate = useHostedOAuthGate({
    surface: "score",
    // Its OWN sentinel. Naming the hosted marker's key here would overwrite the
    // marker with `"true"` and dead-end the callback — see
    // SCORE_OAUTH_PENDING_KEY.
    pendingKey: SCORE_OAUTH_PENDING_KEY,
    projectId,
    servers: oauthDescriptors,
  });

  // The hook returns a fresh object each render. The run effect deliberately
  // reads its latest `runAll` implementation without depending on that object.
  const runRef = useRef(run);
  runRef.current = run;
  const resetPersistence = useScoreRunPersistence({
    phase,
    setPhase,
    server,
    run,
    setError,
    setResultToken,
  });

  const startRun = useCallback(
    async ({ serverUrl, deliveryEmail }: ScoreRunIntent) => {
      setError(null);
      setResultToken(null);
      setPhase("preparing");

      if (isScoreDesignWalkthrough(serverUrl, projectId)) {
        await playScoreDesignWalkthrough({
          preparing: () => setPhase("preparing"),
          running: () => setPhase("running"),
          done: () => {
            setResultToken(SCORE_PREVIEW_RESULT_TOKEN);
            setPhase("done");
          },
        });
        return;
      }

      // Declared outside the try: the catch needs it to write the resume
      // record when the server turns out to require authorization.
      let name = "";
      try {
        const prepared = await prepareServer(serverUrl);
        name = prepared.name;
        setServer(prepared.server);

        // A tagged 401 means the server is reachable but requires OAuth before
        // the conformance suites can run truthfully.
        await validateHostedServer(name);
        setPhase("running");
      } catch (err) {
        if (isOAuthRequiredError(err)) {
          writeScoreRunResume({
            serverUrl,
            serverName: name,
            deliveryEmail,
          });
          setPhase("authorizing");
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
        setPhase("form");
      }
    },
    [prepareServer, projectId],
  );

  // `runAll` needs the hook to have re-keyed onto the new server first — it
  // reads `server` from its own closure — so the run is kicked off by an
  // effect once both the phase and the identity line up.
  const startedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (phase !== "running" || !server) return;
    if (startedForRef.current === server.name) return;
    startedForRef.current = server.name;
    // Through the ref, not the closure: `run` is a fresh object every render,
    // and the one captured here is the pre-run snapshot. The continuation only
    // advances the phase — the save itself happens in the effect below, after
    // the results have actually committed.
    void runRef.current.runAll().then(() => setPhase("run-complete"));
  }, [phase, server]);

  const beginRun = useCallback(
    (intent: ScoreRunIntent) => {
      clearScoreRunResume();
      startedForRef.current = null;
      resetPersistence();
      // Re-key the conformance hook so a retry cannot display results from the
      // previous server while the new handshake is preparing.
      setServer(null);
      void startRun(intent);
    },
    [resetPersistence, startRun],
  );

  // Coming back from a connect-OAuth redirect: the hosted marker restored the
  // server's authorization, but only this record knows a scan was in flight.
  const resumedRef = useRef(false);
  useEffect(() => {
    if (resumedRef.current) return;
    if (appReady.status !== "ready") return;
    const resume = readScoreRunResume();
    if (!resume) return;
    resumedRef.current = true;
    clearScoreRunResume();
    setResumeRecord(resume);
  }, [appReady.status]);

  const resultUrl = useMemo(
    () =>
      resultToken
        ? `${window.location.origin}${routePaths.scoreResults}/${resultToken}`
        : null,
    [resultToken],
  );

  const busy = isScoreRunnerBusy(phase) || run.isRunning;

  const requestDeliveryEmail = useCallback(() => {
    setError(null);
    setPhase("email");
  }, []);

  const reportInputError = useCallback((message: string) => {
    setError(message);
  }, []);

  const consumeResumeRecord = useCallback(() => setResumeRecord(null), []);

  const authorizeServer = useCallback(() => {
    if (!server || !serverId) return;
    void oauthGate.authorizeServer({
      serverId,
      serverName: server.name,
      useOAuth: true,
      serverUrl: getServerUrl(server),
      clientId: null,
      oauthScopes: null,
    });
  }, [oauthGate, server, serverId]);

  return {
    phase,
    error,
    busy,
    formDisabled: busy || appReady.status !== "ready",
    appReadyMessage: appReady.status !== "ready" ? appReadyMessage : null,
    resultUrl,
    showAuthorize: phase === "authorizing" && Boolean(server && serverId),
    authorizeServer,
    authorizeBusy: oauthGate.hasBusyOAuth,
    beginRun,
    requestDeliveryEmail,
    reportInputError,
    resumeRecord,
    consumeResumeRecord,
  };
}
