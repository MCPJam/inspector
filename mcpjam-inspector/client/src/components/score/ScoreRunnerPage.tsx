import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
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
  submitScoreRun,
  toScoreSummary,
  type ScoreSuiteId,
  type ScoreSuiteSummary,
} from "@/lib/apis/score-api";
import { ScoreRunnerView } from "./ScoreRunnerView";
import {
  isScoreRunnerBusy,
  type ScoreRunnerPhase,
} from "./score-runner-view-model";
import { normalizeScoreEmail } from "./score-email";
import { normalizeScoreUrl } from "./score-url";
import { deriveScoreServerName } from "./score-server-name";
import {
  clearScoreRunResume,
  readScoreRunResume,
  writeScoreRunResume,
} from "./score-run-resume";

type Phase = ScoreRunnerPhase;

/** `oauthRequired` is carried on a thrown, tagged 401 — never on a return value. */
function isOAuthRequiredError(error: unknown): boolean {
  return (
    error instanceof WebApiError &&
    (error.details as { oauthRequired?: unknown } | undefined)
      ?.oauthRequired === true
  );
}

export function ScoreRunnerPage({
  convexProjectId,
}: {
  /** The guest's (or member's) project, from the app route context. */
  convexProjectId: string | null;
}) {
  const appReady = useAppReady();
  const appReadyMessage = useAppReadyMessage();
  const createServerIfMissing = useMutation(
    "servers:createServerIfMissing" as any,
  );
  const updateServer = useMutation("servers:updateServer" as any);

  const [urlInput, setUrlInput] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [pendingServerUrl, setPendingServerUrl] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState<string | null>(null);
  const [server, setServer] = useState<ServerWithName | null>(null);
  const [resultToken, setResultToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const run = useConformanceRun({
    // A placeholder keeps the hook's contract simple: it always has a server.
    // Nothing runs until `runAll` is called, and that only happens once a real
    // row exists.
    server: server ?? {
      name: "",
      config: {} as ServerWithName["config"],
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
    },
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
              serverUrl:
                (server.config as { url?: string } | undefined)?.url ?? null,
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

  /** Poll `serverIdsByName` until bootstrap has the new row. */
  const waitForServerId = useCallback(async (name: string): Promise<string> => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const id = tryResolveProjectServer(name)?.serverId;
      if (id) return id;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // `buildServerRequest` would otherwise throw BootstrapNotReadyError deep
    // inside the first suite call, which reads as a mysterious failure of
    // the scan rather than of setup.
    throw new Error(
      "Timed out preparing the workspace for this server. Reload and try again.",
    );
  }, []);

  /**
   * The hook's latest output, readable from an async continuation.
   *
   * `persistRun` runs after `await runAll()`, and `runAll` reports results by
   * setting state. A callback that closed over `run` would therefore be
   * holding the snapshot from BEFORE the suites reported — `pooledScore`
   * undefined, every result empty — and would silently save nothing. Reading
   * through a ref is what makes the saved report the one the visitor is
   * actually looking at.
   */
  const runRef = useRef(run);
  runRef.current = run;

  /**
   * Which settled OAuth status the last stored report already contained.
   *
   * Written by `persistRun` itself rather than by either caller, because the
   * question it answers is "what did the payload we just sent include?" — and
   * only the function that built the payload knows. Seeding it from the save
   * is what stops the resave effect from storing a second, identical run when
   * the OAuth suite happened to settle DURING `runAll` (the common case for a
   * server that fails at discovery or registration, where the suite grades a
   * failure without ever prompting anyone).
   */
  const persistedOAuthStatusRef = useRef<string | null>(null);

  const persistRun = useCallback(
    async (serverUrl: string): Promise<boolean> => {
      const current = runRef.current;
      if (!current.pooledScore) {
        // Nothing applicable anywhere — there is no number to save, and no link
        // worth handing out for it. (`pooledScore` is a ConformanceScore OBJECT,
        // so a legitimate score of 0 is `{score: 0, …}` and stays truthy.)
        setPhase("done");
        return false;
      }
      setPhase("saving");
      try {
        const suiteSummaries: ScoreSuiteSummary[] = (
          [
            ["protocol", current.protocolScore],
            ["apps", current.appsScore],
            ["tasks", current.tasksScore],
            ["oauth", current.oauthScore],
          ] as const
        )
          .filter(([, score]) => score !== undefined)
          .map(([suiteId, score]) => ({
            suiteId: suiteId as ScoreSuiteId,
            ...toScoreSummary(score!),
          }));

        const { token } = await submitScoreRun({
          serverUrl,
          summary: toScoreSummary(current.pooledScore),
          suiteSummaries,
          report: {
            protocol: current.protocol.result,
            apps: current.apps.result,
            tasks: current.tasks.result,
            oauth: current.oauth.result,
          },
        });
        setResultToken(token);
        // Record what this payload actually contained, so a resave only ever
        // fires for an OAuth status the stored report does NOT already have.
        if (
          current.oauth.status === "done" &&
          current.oauthScore !== undefined
        ) {
          persistedOAuthStatusRef.current = current.oauth.status;
        }
        return true;
      } catch (err) {
        // A save failure must not hide the score the visitor already has on
        // screen — they just don't get a link for it.
        setError(
          err instanceof Error
            ? `Scan finished, but the shareable link could not be saved: ${err.message}`
            : "Scan finished, but the shareable link could not be saved.",
        );
        return false;
      } finally {
        setPhase("done");
      }
    },
    [],
  );

  const startRun = useCallback(
    async (normalizedUrl: string, deliveryEmail: string) => {
      setError(null);
      setResultToken(null);
      setPhase("preparing");

      // Declared outside the try: the catch needs it to write the resume
      // record when the server turns out to require authorization.
      let name = "";
      try {
        name = await deriveScoreServerName(normalizedUrl);
        if (!projectId) {
          throw new Error(
            "Still setting up your workspace. Give it a moment and try again.",
          );
        }
        await createServerIfMissing({
          projectId,
          name,
          enabled: true,
          transportType: "http",
          url: normalizedUrl,
          // "Figure out what this server needs" — the only honest setting for a
          // URL somebody pasted, and load-bearing rather than cosmetic. A row
          // with no authMethod resolves through the legacy branch of
          // `resolveEffectiveAuthMethod` to "none", and ONLY the "discover"
          // mode converts a live 401 into the tagged `oauthRequired` error the
          // OAuth branch below detects. Without it a server that requires
          // authorization reports its raw transport failure and the visitor is
          // never offered the flow that would have let them in.
          authMethod: "auto",
        } as any);

        const createdServerId = await waitForServerId(name);
        // `createServerIfMissing` is idempotent: a row from an earlier scan is
        // returned untouched, authMethod and all. Rows minted before that field
        // was set here would stay permanently un-escalatable — and the name is
        // derived from the URL, so a retry finds the same stale row rather than
        // a fresh one. Reconcile it instead of leaving the visitor stuck.
        try {
          await updateServer({
            serverId: createdServerId,
            authMethod: "auto",
          } as any);
        } catch {
          // Best effort. A new row already has the right value, so this only
          // matters for pre-existing ones, and failing here must not abort a
          // scan that is otherwise fine.
        }

        const nextServer: ServerWithName = {
          name,
          config: { url: normalizedUrl } as ServerWithName["config"],
          lastConnectionTime: new Date(),
          connectionStatus: "disconnected",
          retryCount: 0,
        };
        setServer(nextServer);

        // Does this server need authorization before anything can run? The
        // suites would otherwise all come back with the same 401 and grade a
        // server we never actually reached.
        //
        // The route SIGNALS this by throwing a tagged 401, not by returning a
        // flag — `oauthRequired` rides `WebApiError.details` (see
        // `local-server-resolver`). Reading it off the resolved value would
        // never be true, and the throw would land in the generic catch below
        // as "your scan failed", with no way to authorize.
        await validateHostedServer(name);
        setPhase("running");
      } catch (err) {
        if (isOAuthRequiredError(err)) {
          writeScoreRunResume({
            serverUrl: normalizedUrl,
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
    [createServerIfMissing, updateServer, projectId, waitForServerId],
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

  const persistedRunRef = useRef<string | null>(null);
  useEffect(() => {
    if (phase !== "run-complete" || !server) return;
    const serverUrl = (server.config as { url?: string } | undefined)?.url;
    if (!serverUrl) {
      setPhase("done");
      return;
    }
    // Exactly once per run: an effect can re-fire, and a second save would
    // hand out a second link for the same scan.
    if (persistedRunRef.current === server.name) return;
    persistedRunRef.current = server.name;
    void persistRun(serverUrl);
  }, [phase, server, persistRun]);

  /**
   * OAuth is opt-in and finishes AFTER the run settles, so the first save
   * necessarily records a run without it. If the visitor then authorizes, the
   * screen would show one score and the link a different, lower-information
   * one. Save again and hand out the newer link: both saves are truthful about
   * what ran, and the one the visitor is holding always matches what they see.
   */
  /**
   * The OAuth resave gets ONE attempt, ever.
   *
   * Without a cap, a failing save loops: `persistRun` ends in `setPhase("done")`
   * whether it succeeded or not, which re-satisfies this effect's own
   * condition, which saves again — the page oscillates between Saving and Done
   * and hammers the endpoint until the per-IP limit cuts it off. "Retry on
   * failure" and "no bound" are only safe apart.
   */
  const oauthResaveAttemptsRef = useRef(0);
  const oauthResaveInFlightRef = useRef(false);
  useEffect(() => {
    // Deliberately NOT gated on an existing `resultToken`: if the first save
    // failed, a settled OAuth run is the visitor's second chance at getting a
    // link at all.
    if (phase !== "done") return;
    const serverUrl = (server?.config as { url?: string } | undefined)?.url;
    if (!serverUrl) return;
    // Only a transition INTO a finished OAuth state re-saves; a repeat render
    // of the same state must not.
    const settled = run.oauth.status === "done" && run.oauthScore !== undefined;
    if (!settled) return;
    if (persistedOAuthStatusRef.current === run.oauth.status) return;
    if (oauthResaveInFlightRef.current) return;
    // One attempt. Spending it leaves the visitor at a stable state — a score
    // on screen, and either a link or a plain message saying the link could
    // not be saved.
    if (oauthResaveAttemptsRef.current >= 1) return;
    oauthResaveAttemptsRef.current += 1;
    oauthResaveInFlightRef.current = true;
    void persistRun(serverUrl).then(() => {
      oauthResaveInFlightRef.current = false;
      // `persistRun` records the status it actually stored, on success only —
      // one owner for that fact, so a failed save can still be followed by a
      // later status change (bounded by the attempt cap above).
    });
  }, [phase, run.oauth.status, run.oauthScore, server, persistRun]);

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
    setUrlInput(resume.serverUrl);
    const deliveryEmail = resume.deliveryEmail ?? "";
    setEmailInput(deliveryEmail);
    void startRun(resume.serverUrl, deliveryEmail);
  }, [appReady.status, startRun]);

  const resultUrl = useMemo(
    () =>
      resultToken
        ? `${window.location.origin}${routePaths.scoreResults}/${resultToken}`
        : null,
    [resultToken],
  );

  const busy = isScoreRunnerBusy(phase) || run.isRunning;

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const normalized = normalizeScoreUrl(urlInput);
    if (!normalized) {
      setError("Enter a valid http(s) MCP server URL.");
      return;
    }
    setError(null);
    setPendingServerUrl(normalized);
    setPhase("email");
  };

  const onEmailSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const normalizedEmail = normalizeScoreEmail(emailInput);
    if (!normalizedEmail) {
      setError("Enter a valid email address.");
      return;
    }
    if (!pendingServerUrl) {
      setError("Enter the MCP server URL again.");
      setPhase("form");
      return;
    }

    setEmailInput(normalizedEmail);
    setError(null);
    startedForRef.current = null;
    // Drop any resume record from an abandoned run. `authorizing` leaves the
    // form enabled, so a visitor can walk away from an OAuth prompt and paste
    // a different URL — and a stale record would hijack the next reload back
    // to the server they gave up on.
    clearScoreRunResume();
    persistedRunRef.current = null;
    persistedOAuthStatusRef.current = null;
    oauthResaveAttemptsRef.current = 0;
    oauthResaveInFlightRef.current = false;
    // Clearing the server re-keys `useConformanceRun`, which drops the prior
    // suite states. Without it the old server's score stays on screen through
    // "preparing" — and stays there permanently if setup fails and the phase
    // returns to "form" — labelled with the URL the visitor just typed.
    setServer(null);
    void startRun(pendingServerUrl, normalizedEmail);
  };

  const copyResultUrl = () => {
    if (!resultUrl) return;
    // `writeText` rejects without focus or permission. Show "Copied" only
    // once the write actually resolved — a tick over an empty clipboard
    // is worse than no tick.
    const write = navigator.clipboard?.writeText?.(resultUrl);
    if (!write) {
      setError("Could not copy the link. Copy it manually.");
      return;
    }
    void write
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => setError("Could not copy the link. Copy it manually."));
  };

  return (
    <ScoreRunnerView
      urlInput={urlInput}
      onUrlChange={setUrlInput}
      onSubmit={onSubmit}
      emailInput={emailInput}
      onEmailChange={setEmailInput}
      onEmailSubmit={onEmailSubmit}
      phase={phase}
      error={error}
      busy={busy}
      formDisabled={busy || appReady.status !== "ready"}
      appReadyMessage={appReady.status !== "ready" ? appReadyMessage : null}
      resultUrl={resultUrl}
      copied={copied}
      onCopy={copyResultUrl}
      showAuthorize={phase === "authorizing" && Boolean(server && serverId)}
      onAuthorize={() => {
        if (!server || !serverId) return;
        void oauthGate.authorizeServer({
          serverId,
          serverName: server.name,
          useOAuth: true,
          serverUrl:
            (server.config as { url?: string } | undefined)?.url ?? null,
          clientId: null,
          oauthScopes: null,
        });
      }}
      authorizeBusy={oauthGate.hasBusyOAuth}
    />
  );
}
