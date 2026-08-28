import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useMutation } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { ArrowRight, Loader2, ShieldCheck } from "lucide-react";
import { useAppReady, useAppReadyMessage } from "@/hooks/use-app-ready";
import { useHostedOAuthGate } from "@/hooks/hosted/use-hosted-oauth-gate";
import { tryResolveProjectServer } from "@/lib/apis/web/context";
import { validateHostedServer } from "@/lib/apis/web/servers-api";
import { WebApiError } from "@/lib/apis/web/base";
import { SCORE_OAUTH_PENDING_KEY } from "@/lib/hosted-oauth-callback";
import { routePaths } from "@/lib/app-navigation";
import type { ServerWithName } from "@/state/app-types";
import {
  BenchDefinitionChangedError,
  BenchNotEnabledError,
  cancelBenchRun,
  fetchBenchResult,
  fetchBenchRun,
  isTerminalBenchRunStatus,
  preflightBench,
  quoteBench,
  startBenchRun,
  type BenchPreflight,
  type BenchQuote,
  type BenchResult,
  type BenchRun,
} from "@/lib/apis/bench-api";
import { deriveScoreServerName } from "./score-server-name";
import {
  clearScoreRunResume,
  readScoreRunResume,
  writeScoreRunResume,
} from "./score-run-resume";
import { BenchCategorySelector } from "./BenchCategorySelector";
import { BenchQuoteScreen } from "./BenchQuoteScreen";
import { BenchReport } from "./BenchReport";
import { BenchRunProgress } from "./BenchRunProgress";
import { benchPhaseForRun, shouldPollBenchRun } from "./bench-run-phase";
import {
  forgetBenchResultSecret,
  readBenchResultSecret,
  rememberBenchResultSecret,
} from "./bench-result-secret";

/** How often a live run is re-read. */
const POLL_INTERVAL_MS = 3000;

/**
 * Where a visitor goes to spend real credits or sign in.
 *
 * A plain link for the same reason the conformance runner's CTA is one: the
 * guest promotion proof is a bearer credential that can claim a guest's
 * projects, and putting it in a URL leaks it to history, referrers and logs.
 */
const APP_ORIGIN = "https://app.mcpjam.com";

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
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * The benchmark flow on score.mcpjam.com: classify, price, consent, run, read.
 *
 * ── The state machine is the SERVER'S ────────────────────────────────────────
 *
 * The conformance runner next door executes its suites in the browser, which is
 * why it carries a `run-complete` phase to dodge a React commit race between
 * `runAll` resolving and its results landing in state. Nothing like that exists
 * here and nothing like it is copied: a benchmark runs on the backend, and
 * every phase below is a function of one `GET /runs/:runId` response. The run
 * id lives in the URL, so refresh, a second tab, and coming back tomorrow are
 * all the same operation — read the run, render its status. There is no
 * client-side orchestration to resume because there was never any to lose.
 *
 * ── Setup duplicates the conformance runner's, deliberately ──────────────────
 *
 * Resolving a pasted URL into a saved server row is copied rather than shared.
 * The two flows are diverging (this one needs a stable target and a
 * classification receipt; that one needs nothing but a name), and sharing the
 * setup today would mean a single helper serving two sets of requirements
 * before either has settled.
 */
export function BenchRunnerPage({
  convexProjectId,
}: {
  /** The guest's (or member's) project, from the app route context. */
  convexProjectId: string | null;
}) {
  const { runId: routeRunId } = useParams<{ runId?: string }>();
  const navigate = useNavigate();
  const appReady = useAppReady();
  const appReadyMessage = useAppReadyMessage();
  const createServerIfMissing = useMutation(
    "servers:createServerIfMissing" as any,
  );
  const updateServer = useMutation("servers:updateServer" as any);

  const [urlInput, setUrlInput] = useState("");
  const [setup, setSetup] = useState<"idle" | "preparing" | "authorizing">(
    "idle",
  );
  const [server, setServer] = useState<ServerWithName | null>(null);
  const [preflight, setPreflight] = useState<BenchPreflight | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [trackId, setTrackId] = useState<string | null>(null);
  const [quote, setQuote] = useState<BenchQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [writeConsent, setWriteConsent] = useState(false);
  const [starting, setStarting] = useState(false);
  const [definitionChanged, setDefinitionChanged] = useState(false);
  const [run, setRun] = useState<BenchRun | null>(null);
  const [result, setResult] = useState<BenchResult | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disabled, setDisabled] = useState<string | null>(null);

  const resolved = server ? tryResolveProjectServer(server.name) : null;
  const projectId = resolved?.projectId ?? convexProjectId;
  const serverId = resolved?.serverId;

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
    // Its OWN sentinel, shared with the conformance runner: naming the hosted
    // marker's key here would overwrite the marker and dead-end the callback.
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
    throw new Error(
      "Timed out preparing the workspace for this server. Reload and try again.",
    );
  }, []);

  /** One error funnel, so a disabled backend never reads as a broken page. */
  const reportError = useCallback((err: unknown) => {
    if (err instanceof BenchNotEnabledError) {
      setDisabled(err.message);
      return;
    }
    setError(err instanceof Error ? err.message : String(err));
  }, []);

  const runPreflight = useCallback(
    async (normalizedUrl: string) => {
      setError(null);
      setSetup("preparing");

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
          // Only "discover" turns a live 401 into the tagged `oauthRequired`
          // error the branch below detects; without it a server that requires
          // authorization reports a raw transport failure and the visitor is
          // never offered the flow that would have let them in.
          authMethod: "auto",
        } as any);

        const createdServerId = await waitForServerId(name);
        try {
          await updateServer({
            serverId: createdServerId,
            authMethod: "auto",
          } as any);
        } catch {
          // Best effort: reconciles rows minted before this field was set.
        }

        const nextServer: ServerWithName = {
          name,
          config: { url: normalizedUrl } as ServerWithName["config"],
          lastConnectionTime: new Date(),
          connectionStatus: "disconnected",
          retryCount: 0,
        };
        setServer(nextServer);

        await validateHostedServer(name);

        const target = tryResolveProjectServer(name);
        if (!target?.serverId) {
          throw new Error(
            "Timed out preparing the workspace for this server. Reload and try again.",
          );
        }
        const receipt = await preflightBench({
          projectId: target.projectId,
          serverId: target.serverId,
        });
        setPreflight(receipt);
        // The backend's prefill wins over any ranking: it is what this actor
        // chose last time, and a classifier proposal must not overwrite a
        // decision somebody already made.
        const prefilledCategory =
          receipt.preferences?.categorySlug ??
          receipt.classification?.ranked?.[0]?.categorySlug ??
          receipt.categories.find((entry) => entry.runnable)?.id ??
          null;
        setCategoryId(prefilledCategory);
        setTrackId(
          receipt.preferences?.trackSlug ?? receipt.tracks[0]?.id ?? null,
        );
        setSetup("idle");
      } catch (err) {
        if (isOAuthRequiredError(err)) {
          writeScoreRunResume({ serverUrl: normalizedUrl, serverName: name });
          setSetup("authorizing");
          return;
        }
        setSetup("idle");
        reportError(err);
      }
    },
    [
      createServerIfMissing,
      projectId,
      reportError,
      updateServer,
      waitForServerId,
    ],
  );

  const selection = useMemo(
    () => ({
      ...(categoryId ? { categoryIds: [categoryId] } : {}),
      ...(trackId ? { trackIds: [trackId] } : {}),
    }),
    [categoryId, trackId],
  );

  /**
   * The track the visitor picked, as the object rather than its id. A quote is
   * priced from `profileId` + `version`; `track.id` is `profileId@version` and
   * exists for display and selection, so it is looked up here rather than
   * parsed apart.
   */
  const selectedTrack = useMemo(
    () => preflight?.tracks.find((entry) => entry.id === trackId) ?? null,
    [preflight, trackId],
  );

  const requestQuote = useCallback(async () => {
    // A quote is priced against the stable TARGET and one exact exam, both of
    // which come from preflight — not against the saved server row.
    if (!serverId || !projectId || !preflight || !selectedTrack) return;
    setError(null);
    setDefinitionChanged(false);
    setQuoting(true);
    try {
      const priced = await quoteBench({
        projectId,
        serverId,
        benchmarkTargetId: preflight.benchmarkTargetId,
        profileId: selectedTrack.profileId,
        profileVersion: selectedTrack.version,
        selection,
      });
      setQuote(priced);
      // A fresh quote is a fresh manifest, so a consent given against the
      // previous one does not carry over. Re-ticking is the point.
      setWriteConsent(false);
    } catch (err) {
      reportError(err);
    } finally {
      setQuoting(false);
    }
  }, [preflight, projectId, reportError, selectedTrack, selection, serverId]);

  const start = useCallback(async () => {
    // Starting is ACCEPTING the quote, so there has to be one. The backend
    // re-checks its definition and consent hashes and refuses the run if the
    // exam moved between pricing and starting.
    if (!serverId || !projectId || !preflight || !quote?.quoteId) return;
    setError(null);
    setStarting(true);
    try {
      const started = await startBenchRun({
        projectId,
        serverId,
        quoteId: quote.quoteId,
        receiptId: preflight.receiptId,
        // Gating the button is not consent: the backend re-checks the write
        // manifest against what was agreed to, and it can only do that if the
        // agreement actually travels with the start.
        ...(quote.writesToTarget ? { consent: { writeCases: true } } : {}),
        selection,
        preferences: {
          ...(categoryId ? { categorySlug: categoryId } : {}),
          ...(trackId ? { trackSlug: trackId } : {}),
        },
      });
      setRun(started);
      // THE only moment the plaintext secret exists. The backend keeps a
      // digest and `/runs/:id` cannot return it, so a poll response — which is
      // seconds away — would otherwise overwrite the one copy of the
      // capability that loads the report this run was just paid for.
      if (started.resultSecret) {
        rememberBenchResultSecret(started.benchmarkRunId, started.resultSecret);
      }
      // The run id in the URL is what makes refresh and resume free — this is
      // the only place it is minted, and nothing else is stored.
      navigate(`${routePaths.embedBench}/${started.benchmarkRunId}`, {
        replace: true,
      });
    } catch (err) {
      if (err instanceof BenchDefinitionChangedError) {
        // Deliberately NOT re-quoted here. The visitor consented to a specific
        // manifest; a new one is a new decision, and starting against it
        // silently is the failure this branch exists to prevent.
        setDefinitionChanged(true);
        setQuote(null);
        setWriteConsent(false);
        return;
      }
      reportError(err);
    } finally {
      setStarting(false);
    }
  }, [
    categoryId,
    navigate,
    preflight,
    projectId,
    reportError,
    selection,
    serverId,
    trackId,
  ]);

  const cancel = useCallback(async () => {
    if (!run) return;
    setCancelling(true);
    try {
      setRun(await cancelBenchRun(run.benchmarkRunId));
    } catch (err) {
      reportError(err);
    } finally {
      setCancelling(false);
    }
  }, [reportError, run]);

  /**
   * The whole state machine: read the run, render what it says.
   *
   * Keyed on the id in the URL rather than on anything this component set, so
   * a page loaded cold at `/embed/bench/<runId>` behaves exactly like one that
   * started the run itself.
   */
  useEffect(() => {
    if (!routeRunId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const latest = await fetchBenchRun(routeRunId);
        if (cancelled) return;
        setRun(latest);
        if (shouldPollBenchRun(latest)) {
          timer = setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (cancelled) return;
        // Stop polling on failure rather than hammering: the run id is in the
        // URL, so a reload is the retry.
        reportError(err);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [reportError, routeRunId]);

  /**
   * The report document, once the run has actually finished.
   *
   * Gated on TERMINAL status rather than on holding a secret. The secret is
   * available the instant the run starts, and fetching then answers
   * `ready: false` — a placeholder the relay would once have cached in front
   * of the real report, and which this effect would have recorded as the
   * final answer with no retry.
   *
   * The secret comes from `bench-result-secret`, not from `run`: polling
   * replaces the run row with a shape that has no `resultSecret` in it at all.
   */
  const loadedRunRef = useRef<string | null>(null);
  useEffect(() => {
    if (!routeRunId || !run || !isTerminalBenchRunStatus(run.status)) return;
    if (loadedRunRef.current === routeRunId) return;
    const secret = readBenchResultSecret(routeRunId);
    if (!secret) return;
    loadedRunRef.current = routeRunId;
    let cancelled = false;
    void fetchBenchResult(secret)
      .then((loaded) => {
        if (cancelled) return;
        setResult(loaded);
        // Spent. Holding a capability past the document it opens is a
        // liability, and the report is in memory now.
        forgetBenchResultSecret(routeRunId);
      })
      .catch((err) => {
        if (cancelled) return;
        // Released so a reload can try again: the secret is still the only
        // copy, and a transient failure must not be the thing that loses it.
        loadedRunRef.current = null;
        reportError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [reportError, routeRunId, run]);

  // Coming back from a connect-OAuth redirect: the hosted marker restored the
  // server's authorization, but only this record knows a preflight was in
  // flight.
  const resumedRef = useRef(false);
  useEffect(() => {
    if (resumedRef.current) return;
    if (routeRunId) return;
    if (appReady.status !== "ready") return;
    const resume = readScoreRunResume();
    if (!resume) return;
    resumedRef.current = true;
    clearScoreRunResume();
    setUrlInput(resume.serverUrl);
    void runPreflight(resume.serverUrl);
  }, [appReady.status, routeRunId, runPreflight]);

  const phase = benchPhaseForRun(run);
  const busy = setup === "preparing" || quoting || starting;

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const normalized = normalizeUrlInput(urlInput);
    if (!normalized) {
      setError("Enter a valid http(s) MCP server URL.");
      return;
    }
    // `authorizing` leaves the form enabled, so a visitor can walk away from an
    // OAuth prompt and paste a different URL — a stale record would hijack the
    // next reload back to the server they gave up on.
    clearScoreRunResume();
    setPreflight(null);
    setQuote(null);
    setWriteConsent(false);
    setDefinitionChanged(false);
    setServer(null);
    void runPreflight(normalized);
  };

  if (disabled) {
    return (
      <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
        <h1 className="text-lg font-semibold">Benchmarks aren&apos;t on yet</h1>
        <p className="text-sm text-muted-foreground">{disabled}</p>
        <Button asChild size="sm" variant="outline">
          <a href={routePaths.embedScore}>Run a conformance scan instead</a>
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-6 overflow-y-auto px-6 py-10">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Benchmark your connector</h1>
        <p className="text-sm text-muted-foreground">
          We run a pinned exam against your server on our own infrastructure and
          score what came back. The exam is chosen by category, the result is
          comparable with every other run of the same exam, and nothing about it
          is assembled in your browser.
        </p>
      </header>

      {phase === "select" && !preflight ? (
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
                Reading its tools…
              </>
            ) : (
              <>
                Continue
                <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
              </>
            )}
          </Button>
        </form>
      ) : null}

      {appReady.status !== "ready" && appReadyMessage ? (
        <p className="text-xs text-muted-foreground">{appReadyMessage}</p>
      ) : null}

      {error ? (
        <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
          {error}
        </div>
      ) : null}

      {setup === "authorizing" && server && serverId ? (
        <div className="space-y-3 rounded-md border border-border/50 bg-muted/30 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="h-4 w-4" />
            This server requires authorization
          </div>
          <p className="text-xs text-muted-foreground">
            We can&apos;t measure what a connector does for an authorized client
            without being one. Authorizing sends you to the server&apos;s own
            login and brings you straight back here.
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
      ) : null}

      {phase === "select" && preflight && !quote && !definitionChanged ? (
        <BenchCategorySelector
          categories={preflight.categories}
          tracks={preflight.tracks}
          {...(preflight.classification
            ? { classification: preflight.classification }
            : {})}
          {...(preflight.preferences
            ? { preferences: preflight.preferences }
            : {})}
          selectedCategoryId={categoryId}
          selectedTrackId={trackId}
          onSelectCategory={setCategoryId}
          onSelectTrack={setTrackId}
          onContinue={() => void requestQuote()}
          busy={quoting}
        />
      ) : null}

      {phase === "select" && (quote || quoting || definitionChanged) ? (
        <BenchQuoteScreen
          quote={quote}
          loading={quoting}
          starting={starting}
          writeConsent={writeConsent}
          onWriteConsentChange={setWriteConsent}
          onStart={() => void start()}
          onBack={() => {
            setQuote(null);
            setDefinitionChanged(false);
          }}
          onSignIn={() => {
            window.location.href = `${APP_ORIGIN}/login`;
          }}
          onTopUp={() => {
            window.location.href = `${APP_ORIGIN}/settings/billing`;
          }}
          definitionChanged={definitionChanged}
          onRequote={() => void requestQuote()}
        />
      ) : null}

      {phase === "progress" && run ? (
        <BenchRunProgress
          run={run}
          onCancel={() => void cancel()}
          cancelling={cancelling}
        />
      ) : null}

      {phase === "report" && run ? (
        result ? (
          <BenchReport result={result} />
        ) : run.status === "failed" || run.status === "cancelled" ? (
          <div className="space-y-2 rounded-md border border-border/50 px-4 py-3">
            <div className="text-sm font-medium">
              {run.status === "cancelled"
                ? "This run was cancelled."
                : "We could not produce a result for this run."}
            </div>
            <p className="text-xs text-muted-foreground">
              {/* `failed` is ours, not the connector's: a server that failed
                  every check produces a completed run holding a bad score. */}
              {run.failureMessage ??
                (run.status === "cancelled"
                  ? "Anything it wrote to your connector was still cleaned up."
                  : "This says nothing about your connector — it means we could not interpret what came back.")}
            </p>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading the report…
          </div>
        )
      ) : null}
    </div>
  );
}
