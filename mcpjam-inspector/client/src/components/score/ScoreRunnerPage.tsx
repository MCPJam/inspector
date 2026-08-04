import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Loader2, ArrowRight, ShieldCheck, Link2, Check } from "lucide-react";
import { useMutation } from "convex/react";
import { useAppReady, useAppReadyMessage } from "@/hooks/use-app-ready";
import { useConformanceRun } from "@/hooks/use-conformance-run";
import { useHostedOAuthGate } from "@/hooks/hosted/use-hosted-oauth-gate";
import { tryResolveProjectServer } from "@/lib/apis/web/context";
import { validateHostedServer } from "@/lib/apis/web/servers-api";
import { WebApiError } from "@/lib/apis/web/base";
import { getGuestPromotionProof } from "@/lib/guest-session";
import { routePaths } from "@/lib/app-navigation";
import { ScoreHeadline } from "@/components/conformance/ScoreHeadline";
import type { ServerWithName } from "@/state/app-types";
import {
  submitScoreRun,
  toScoreSummary,
  type ScoreSuiteId,
  type ScoreSuiteSummary,
} from "@/lib/apis/score-api";
import { deriveScoreServerName } from "./score-server-name";
import {
  clearScoreRunResume,
  readScoreRunResume,
  writeScoreRunResume,
} from "./score-run-resume";
import { ScoreSuiteBreakdown } from "./ScoreSuiteBreakdown";

/** Where "Debug these failures in MCPJam" sends a visitor. */
const APP_ORIGIN = "https://app.mcpjam.com";

type Phase =
  | "form"
  | "preparing"
  | "authorizing"
  | "running"
  /**
   * The suites have settled but their results may not have COMMITTED yet.
   * `runAll` schedules React state updates and then resolves, so its promise
   * continuation is a microtask that can run before the commit — persisting
   * from there could still read a pre-run snapshot. This phase exists so the
   * save is triggered by an effect, which React only runs after the commit.
   */
  | "run-complete"
  | "saving"
  | "done";

/** `oauthRequired` is carried on a thrown, tagged 401 — never on a return value. */
function isOAuthRequiredError(error: unknown): boolean {
  return (
    error instanceof WebApiError &&
    (error.details as { oauthRequired?: unknown } | undefined)
      ?.oauthRequired === true
  );
}

function normalizeUrlInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // A pasted host with no scheme is the single most common way this form gets
  // filled. Assume https rather than rejecting it — http would be a downgrade
  // nobody asked for.
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return null;
    return parsed.toString();
  } catch {
    return null;
  }
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
    "servers:createServerIfMissing" as any
  );

  const [urlInput, setUrlInput] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState<string | null>(null);
  const [server, setServer] = useState<ServerWithName | null>(null);
  const [resultToken, setResultToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [ctaHref, setCtaHref] = useState(APP_ORIGIN);

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
    [server, serverId]
  );

  const oauthGate = useHostedOAuthGate({
    surface: "score",
    pendingKey: "mcp-hosted-oauth-pending",
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
      "Timed out preparing the workspace for this server. Reload and try again."
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

  const persistRun = useCallback(async (serverUrl: string) => {
    const current = runRef.current;
    if (!current.pooledScore) {
      // Nothing applicable anywhere — there is no number to save, and no link
      // worth handing out for it.
      setPhase("done");
      return;
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
    } catch (err) {
      // A save failure must not hide the score the visitor already has on
      // screen — they just don't get a link for it.
      setError(
        err instanceof Error
          ? `Scan finished, but the shareable link could not be saved: ${err.message}`
          : "Scan finished, but the shareable link could not be saved."
      );
    } finally {
      setPhase("done");
    }
  }, []);

  const startRun = useCallback(
    async (normalizedUrl: string) => {
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
            "Still setting up your workspace. Give it a moment and try again."
          );
        }
        await createServerIfMissing({
          projectId,
          name,
          enabled: true,
          transportType: "http",
          url: normalizedUrl,
        } as any);

        await waitForServerId(name);

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
          writeScoreRunResume({ serverUrl: normalizedUrl, serverName: name });
          setPhase("authorizing");
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
        setPhase("form");
      }
    },
    [createServerIfMissing, projectId, waitForServerId]
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
  const persistedOAuthStatusRef = useRef<string | null>(null);
  useEffect(() => {
    if (phase !== "done" || !resultToken) return;
    const serverUrl = (server?.config as { url?: string } | undefined)?.url;
    if (!serverUrl) return;
    // Only a transition INTO a finished OAuth state re-saves; a repeat render
    // of the same state must not.
    const settled = run.oauth.status === "done" && run.oauthScore !== undefined;
    if (!settled) return;
    if (persistedOAuthStatusRef.current === run.oauth.status) return;
    persistedOAuthStatusRef.current = run.oauth.status;
    void persistRun(serverUrl);
  }, [
    phase,
    resultToken,
    run.oauth.status,
    run.oauthScore,
    server,
    persistRun,
  ]);

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
    void startRun(resume.serverUrl);
  }, [appReady.status, startRun]);

  // The guest cookie is host-only, so a bare link to app.mcpjam.com would
  // arrive with no guest identity and promote nothing. Carry a one-shot
  // promotion proof in the CTA instead, so signing in there absorbs this
  // guest project — server row and all — into the new account.
  useEffect(() => {
    if (phase !== "done") return;
    let cancelled = false;
    void getGuestPromotionProof().then((proof) => {
      if (cancelled) return;
      setCtaHref(
        proof
          ? `${APP_ORIGIN}/servers?guestProof=${encodeURIComponent(proof)}`
          : `${APP_ORIGIN}/servers`
      );
    });
    return () => {
      cancelled = true;
    };
  }, [phase]);

  const resultUrl = useMemo(
    () =>
      resultToken
        ? `${window.location.origin}${routePaths.scoreResults}/${resultToken}`
        : null,
    [resultToken]
  );

  const busy =
    phase === "preparing" ||
    phase === "running" ||
    phase === "run-complete" ||
    phase === "saving" ||
    run.isRunning;

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const normalized = normalizeUrlInput(urlInput);
    if (!normalized) {
      setError("Enter a valid http(s) MCP server URL.");
      return;
    }
    startedForRef.current = null;
    // Drop any resume record from an abandoned run. `authorizing` leaves the
    // form enabled, so a visitor can walk away from an OAuth prompt and paste
    // a different URL — and a stale record would hijack the next reload back
    // to the server they gave up on.
    clearScoreRunResume();
    persistedRunRef.current = null;
    persistedOAuthStatusRef.current = null;
    void startRun(normalized);
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-6 overflow-y-auto px-6 py-10">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Score your MCP server</h1>
        <p className="text-sm text-muted-foreground">
          Paste a server URL. We run the protocol, apps, tasks and OAuth
          conformance suites against it and give you one number out of 100, with
          every check we judged it on.
        </p>
      </header>

      <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={urlInput}
          onChange={(event) => setUrlInput(event.target.value)}
          placeholder="https://mcp.example.com/mcp"
          aria-label="MCP server URL"
          disabled={busy}
          className="h-10 min-w-0 flex-1 rounded-md border border-border/60 bg-background px-3 text-sm outline-none focus:border-foreground/30"
        />
        <Button type="submit" disabled={busy || appReady.status !== "ready"}>
          {busy ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              {phase === "preparing"
                ? "Preparing…"
                : phase === "saving"
                ? "Saving…"
                : "Scanning…"}
            </>
          ) : (
            <>
              Score it
              <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
            </>
          )}
        </Button>
      </form>

      {appReady.status !== "ready" && appReadyMessage && (
        <p className="text-xs text-muted-foreground">{appReadyMessage}</p>
      )}

      <p className="text-xs text-muted-foreground">
        Hosted scans reach your server over the public internet, so a stdio
        server or one on localhost can&apos;t be scored here — run those locally
        with{" "}
        <code className="rounded bg-muted px-1 py-0.5">
          npx @mcpjam/inspector
        </code>
        .
      </p>

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
          {error}
        </div>
      )}

      {phase === "authorizing" && server && serverId && (
        <div className="space-y-3 rounded-md border border-border/50 bg-muted/30 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="h-4 w-4" />
            This server requires authorization
          </div>
          <p className="text-xs text-muted-foreground">
            We can&apos;t check what a server does for an authorized client
            without being one. Authorizing sends you to the server&apos;s own
            login and brings you straight back here to finish the scan.
          </p>
          <Button
            size="sm"
            onClick={() =>
              void oauthGate.authorizeServer({
                serverId,
                serverName: server.name,
                useOAuth: true,
                serverUrl:
                  (server.config as { url?: string } | undefined)?.url ?? null,
                clientId: null,
                oauthScopes: null,
              })
            }
            disabled={oauthGate.hasBusyOAuth}
          >
            Authorize and continue
          </Button>
        </div>
      )}

      {(run.pooledScore || busy) && (
        <div className="space-y-4">
          <ScoreHeadline
            score={run.pooledScore}
            oauthNotScored={run.oauthNotScored}
            size="hero"
          />
          <ScoreSuiteBreakdown
            protocol={run.protocol}
            apps={run.apps}
            tasks={run.tasks}
            oauth={run.oauth}
            protocolScore={run.protocolScore}
            appsScore={run.appsScore}
            tasksScore={run.tasksScore}
            oauthScore={run.oauthScore}
            onAuthorizeOAuth={run.authorizeOAuth}
          />
        </div>
      )}

      {phase === "done" && (
        <div className="space-y-3 rounded-md border border-border/50 px-4 py-3">
          {resultUrl && (
            <div className="space-y-1">
              <div className="text-xs font-medium">Private result link</div>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-[11px]">
                  {resultUrl}
                </code>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    // `writeText` rejects without focus or permission. Show the
                    // check mark only once the write actually resolved — a tick
                    // over an empty clipboard is worse than no tick.
                    const write = navigator.clipboard?.writeText?.(resultUrl);
                    if (!write) {
                      // No Clipboard API at all (insecure context, older
                      // browser) — same outcome as a rejected write.
                      setError("Could not copy the link. Copy it manually.");
                      return;
                    }
                    void write
                      .then(() => {
                        setCopied(true);
                        window.setTimeout(() => setCopied(false), 2000);
                      })
                      .catch(() =>
                        setError("Could not copy the link. Copy it manually.")
                      );
                  }}
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Link2 className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Anyone with this link can read the report. It is not listed
                anywhere.
              </p>
            </div>
          )}
          <Button asChild size="sm">
            <a href={ctaHref}>Debug these failures in MCPJam</a>
          </Button>
        </div>
      )}
    </div>
  );
}
