/**
 * One directory-readiness section's run, in either execution mode.
 *
 * ## Why this is not `use-conformance-run`
 *
 * That hook runs four suites that are all the same shape: one await, one
 * verdict, a score. Readiness is neither shape — locally it is a synchronous
 * call that answers inline, and hosted it is a durable run with a lease, a
 * poll, a cancel and a separately-fetched report. It also carries inputs no
 * suite has (a declared submission mode, a billed opt-in) and produces a
 * verdict vocabulary that does not compose into the pooled score.
 *
 * Bolting all of that onto a 690-line hook with a second consumer would make
 * every reader of the conformance page pay for readiness's complexity.
 *
 * ## What is copied from it, deliberately
 *
 * The run-token and `serverConfigKey` discipline. Those are the genuinely
 * subtle parts — a late response from a previous server must not land in the
 * new server's state — and they are worth duplicating rather than sharing,
 * because the sharing would be the coupling above.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  canRunConformance,
  isOpenAIReadinessResult,
  type OpenAISubmissionMode,
} from "@mcpjam/sdk/browser";
import { isPlatformApiError } from "@mcpjam/sdk/platform";
import {
  cancelHostedReadinessRun,
  canRunHostedReadiness,
  findLatestHostedReadinessRun,
  getHostedReadinessReport,
  getHostedReadinessRun,
  isTerminalRunStatus,
  resumeHostedReadinessRun,
  runLocalReadiness,
  startHostedReadiness,
  type DirectoryReadinessPublisher,
  type DirectoryReadinessResult,
  type HostedSubmissionMode,
  type ReadinessRun,
  type ReadinessRunReceipt,
} from "@/lib/apis/directory-readiness-api";
import { isHostedMode } from "@/lib/apis/mode-client";

export type ReadinessSectionStatus =
  | "idle"
  | "running"
  | "done"
  | "error"
  | "unavailable";

export interface DirectoryReadinessState {
  status: ReadinessSectionStatus;
  /** Why this server cannot be graded at all (stdio, no URL). */
  unavailableReason?: string;
  error?: string;
  /** The hosted run row, absent for a local run. */
  run?: ReadinessRun;
  /** The graded report: inline locally, lazily fetched when hosted. */
  report?: DirectoryReadinessResult;
  /** True while the report itself is being fetched. */
  reportLoading?: boolean;
  reportError?: string;
}

interface ServerLike {
  name: string;
  config?: unknown;
}

/**
 * Poll intervals, widening as a run proves it is long.
 *
 * A readiness run dials somebody else's server: the first answers arrive in
 * seconds, and a run still going after a minute is usually waiting on a slow
 * hop rather than about to finish. Polling every two seconds for fifteen
 * minutes would be a request per second per open tab for a row that changes
 * twice, so the interval widens and the tail is cheap.
 */
const POLL_LADDER_MS = [2_000, 5_000, 15_000] as const;
/** Steps at each rung before widening. */
const POLL_STEPS_PER_RUNG = 5;

/**
 * Jitter, because every tab watching the same run would otherwise poll in
 * lockstep after a deploy or a network blip.
 */
function withJitter(intervalMs: number): number {
  return intervalMs + Math.floor(Math.random() * (intervalMs * 0.2));
}

function pollIntervalFor(tick: number): number {
  const rung = Math.min(
    Math.floor(tick / POLL_STEPS_PER_RUNG),
    POLL_LADDER_MS.length - 1,
  );
  return withJitter(POLL_LADDER_MS[rung]!);
}

/** Transient resume failures tried again for one re-queue. */
const RESUME_TRIES = 3;

/** A 4xx other than a timeout or rate limit: asking again gets the same answer. */
function isDefiniteRefusal(error: unknown): boolean {
  return (
    isPlatformApiError(error) &&
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 425, 429].includes(error.status)
  );
}

interface ResumeAttempt {
  /** `runId:attemptCount`: recovery counts each re-queue as an attempt. */
  requeue: string;
  /** Resumed, or refused for good. */
  settled: boolean;
  inFlight: boolean;
  transientFailures: number;
}

export interface UseDirectoryReadinessRunOptions {
  publisher: DirectoryReadinessPublisher;
  server: ServerLike;
  /** Required for OpenAI. Never inferred — see the section component. */
  submissionMode?: HostedSubmissionMode;
  includeLlmObservations?: boolean;
  /**
   * Starts the run through another route, such as a directory submission's.
   * Always hosted, and no report is fetched: that caller reads the results
   * placed on its own form. Keep it stable: a new one resets the run.
   */
  start?: (idempotencyKey: string) => Promise<ReadinessRunReceipt>;
}

export function useDirectoryReadinessRun({
  publisher,
  server,
  submissionMode,
  includeLlmObservations = false,
  start,
}: UseDirectoryReadinessRunOptions) {
  const hosted = isHostedMode();

  const initialState = useCallback((): DirectoryReadinessState => {
    // Readiness grades an HTTP endpoint, so the transport question is the same
    // one the protocol suite asks. Answering it here means a stdio server
    // shows "Unavailable" rather than making the request and reading a 400.
    const support = canRunConformance(
      "protocol",
      server.config as Parameters<typeof canRunConformance>[1],
    );
    if (!support.supported) {
      return { status: "unavailable", unavailableReason: support.reason };
    }
    return { status: "idle" };
  }, [server.config]);

  const [state, setState] = useState<DirectoryReadinessState>(initialState);

  // See `use-conformance-run`: the name alone is not enough, because editing a
  // server's URL in place would leave the previous target's grade on screen.
  const serverConfigKey = useMemo(() => {
    const config = server.config as
      | { url?: unknown; command?: unknown; args?: unknown }
      | undefined;
    return JSON.stringify([
      server.name,
      config?.url != null ? String(config.url) : null,
      typeof config?.command === "string" ? config.command : null,
      Array.isArray(config?.args) ? config.args : null,
    ]);
  }, [server.name, server.config]);

  /** Bumped by every start and every reset; stale async work checks it. */
  const runTokenRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRunIdRef = useRef<string | null>(null);

  const clearPoll = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    runTokenRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    activeRunIdRef.current = null;
    clearPoll();
    setState(initialState());
  }, [clearPoll, initialState]);

  useEffect(() => {
    reset();
    // `serverConfigKey` is the trigger; the rest is read through it. A new
    // `start` is a new thing to grade, such as another submission.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverConfigKey, publisher, start]);

  useEffect(() => {
    return () => {
      runTokenRef.current += 1;
      abortRef.current?.abort();
      clearPoll();
    };
  }, [clearPoll]);

  const isCurrent = useCallback((token: number) => {
    return token === runTokenRef.current;
  }, []);

  /** The latest re-queue this hook tried to resume. */
  const resumeRef = useRef<ResumeAttempt | null>(null);

  /**
   * A run whose node stopped is re-queued, and only the person who started
   * it can run it again, with their credentials. Resume once per re-queue,
   * then keep polling: a refusal (another person's run, or one resumed
   * elsewhere first) leaves nothing to do that the poll will not show. A
   * failure that is not a refusal, such as an outage, is tried again on later
   * polls, up to `RESUME_TRIES` times.
   */
  const resumeOnce = useCallback(async (run: ReadinessRun) => {
    if (!run.resumable) return;
    const requeue = `${run.id}:${run.attemptCount}`;
    const attempt: ResumeAttempt =
      resumeRef.current?.requeue === requeue
        ? resumeRef.current
        : { requeue, settled: false, inFlight: false, transientFailures: 0 };
    resumeRef.current = attempt;
    if (
      attempt.settled ||
      attempt.inFlight ||
      attempt.transientFailures >= RESUME_TRIES
    ) {
      return;
    }
    attempt.inFlight = true;
    try {
      await resumeHostedReadinessRun(run.id);
      attempt.settled = true;
    } catch (error) {
      if (isDefiniteRefusal(error)) attempt.settled = true;
      else attempt.transientFailures += 1;
      if (import.meta.env?.DEV) {
        console.warn("[readiness] resume failed", error);
      }
    } finally {
      attempt.inFlight = false;
    }
  }, []);

  /** One poll, then schedule the next unless the run is done. */
  const pollRun = useCallback(
    async (runId: string, token: number, tick: number) => {
      if (!isCurrent(token)) return;
      // PAUSED WHILE HIDDEN. A backgrounded tab watching a fifteen-minute run
      // is pure load with nobody reading the answer; the visibility listener
      // below resumes with an immediate poll, so nothing is missed.
      if (typeof document !== "undefined" && document.hidden) {
        pollTimerRef.current = setTimeout(
          () => void pollRun(runId, token, tick),
          POLL_LADDER_MS[POLL_LADDER_MS.length - 1]!,
        );
        return;
      }

      try {
        const run = await getHostedReadinessRun(runId);
        if (!isCurrent(token)) return;
        setState((prev) => ({
          ...prev,
          run,
          status: isTerminalRunStatus(run.status) ? "done" : "running",
        }));
        if (isTerminalRunStatus(run.status)) {
          clearPoll();
          return;
        }
        await resumeOnce(run);
        if (!isCurrent(token)) return;
      } catch (error) {
        if (!isCurrent(token)) return;
        // A failed poll is not a failed run: the run continues on the server
        // and the next poll may well succeed. Only a persistent failure that
        // outlasts the run is worth surfacing, and the row's own terminal
        // state is what eventually reports it.
        if (import.meta.env?.DEV) {
          console.warn("[readiness] poll failed", error);
        }
      }

      pollTimerRef.current = setTimeout(
        () => void pollRun(runId, token, tick + 1),
        pollIntervalFor(tick),
      );
    },
    [clearPoll, isCurrent, resumeOnce],
  );

  // Resume immediately when the tab comes back, rather than waiting out the
  // long interval a hidden tab was sitting on.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisible = () => {
      if (document.hidden) return;
      const runId = activeRunIdRef.current;
      if (!runId) return;
      clearPoll();
      void pollRun(runId, runTokenRef.current, 0);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [clearPoll, pollRun]);

  const run = useCallback(async () => {
    runTokenRef.current += 1;
    const token = runTokenRef.current;
    clearPoll();
    setState({ status: "running" });

    try {
      if (!hosted && !start) {
        const controller = new AbortController();
        abortRef.current = controller;
        const { result } = await runLocalReadiness(publisher, server.name, {
          submissionMode: submissionMode as OpenAISubmissionMode | undefined,
        });
        if (!isCurrent(token)) return;
        setState({ status: "done", report: result });
        return;
      }

      // One key per start press: a double-click replays onto the run it
      // already made rather than dialling somebody's server twice.
      const idempotencyKey = `ui-${publisher}-${token}-${Date.now()}`;
      const receipt = start
        ? await start(idempotencyKey)
        : await startHostedReadiness(publisher, server.name, {
            submissionMode,
            includeLlmObservations,
            idempotencyKey,
          });
      if (!isCurrent(token)) return;
      activeRunIdRef.current = receipt.runId;
      void pollRun(receipt.runId, token, 0);
    } catch (error) {
      if (!isCurrent(token)) return;
      setState({
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [
    clearPoll,
    hosted,
    includeLlmObservations,
    isCurrent,
    pollRun,
    publisher,
    server.name,
    start,
    submissionMode,
  ]);

  /** Follow a run started elsewhere, such as one still going after a reload. */
  const watch = useCallback(
    (runId: string) => {
      if (activeRunIdRef.current === runId) return;
      runTokenRef.current += 1;
      activeRunIdRef.current = runId;
      clearPoll();
      void pollRun(runId, runTokenRef.current, 0);
    },
    [clearPoll, pollRun],
  );

  const cancel = useCallback(async () => {
    const runId = activeRunIdRef.current;
    if (!hosted) {
      // Local has no run row; stopping means abandoning the request.
      runTokenRef.current += 1;
      abortRef.current?.abort();
      setState(initialState());
      return;
    }
    if (!runId) return;
    try {
      await cancelHostedReadinessRun(runId);
      // DELIBERATELY KEEPS POLLING. The response is a synthetic `cancelled`;
      // the executing node only learns on its next heartbeat, so the row's
      // real terminal state arrives later. Showing `cancelled` now and then
      // never correcting it would be the UI asserting something it does not
      // know yet.
    } catch (error) {
      setState((prev) => ({
        ...prev,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [hosted, initialState]);

  /**
   * Fetch the full report. Kept callable for retries, but the effect below is
   * the normal path — the first version wired this to the section's expand
   * CLICK, then made the sections open by default, so the click never came
   * and a finished run rendered lane counts with no findings under them. A
   * fetch that only a collapse-and-reopen could trigger is a fetch that never
   * happens.
   */
  const loadReport = useCallback(async () => {
    const runId = state.run?.id;
    if (!runId || state.report || state.reportLoading) return;
    if (!state.run?.hasReport) return;
    const token = runTokenRef.current;
    setState((prev) => ({
      ...prev,
      reportLoading: true,
      reportError: undefined,
    }));
    try {
      const report = await getHostedReadinessReport(runId);
      if (!isCurrent(token)) return;
      setState((prev) => ({ ...prev, report, reportLoading: false }));
    } catch (error) {
      if (!isCurrent(token)) return;
      setState((prev) => ({
        ...prev,
        reportLoading: false,
        reportError: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [isCurrent, state.report, state.reportLoading, state.run]);

  // THE FINDINGS ARRIVE WITH THE VERDICT. The moment a hosted run is terminal
  // and a report exists, fetch it — the row alone renders coverage numbers
  // with nothing under them, which reads as "nothing found" when the truth is
  // "49 findings you cannot see".
  useEffect(() => {
    if (start || !state.run || !isTerminalRunStatus(state.run.status)) return;
    if (!state.run.hasReport || state.report || state.reportLoading) return;
    void loadReport();
  }, [loadReport, start, state.report, state.reportLoading, state.run]);

  /**
   * Adopt the newest run for this server after a reload.
   *
   * Only when this section holds no run of its own, and only for a matching
   * server and publisher — the list endpoint's "newest" is the wrong answer
   * for somebody who was watching an older run.
   */
  const rediscover = useCallback(async () => {
    if (!hosted || activeRunIdRef.current || state.status !== "idle") return;
    if (!canRunHostedReadiness(server.name)) return;
    const token = runTokenRef.current;
    try {
      const latest = await findLatestHostedReadinessRun(publisher, server.name);
      if (!latest || !isCurrent(token)) return;
      activeRunIdRef.current = latest.id;
      setState({
        run: latest,
        status: isTerminalRunStatus(latest.status) ? "done" : "running",
      });
      if (!isTerminalRunStatus(latest.status)) {
        void pollRun(latest.id, token, 0);
      }
    } catch {
      // A page that could not find a previous run simply offers a new one.
    }
  }, [hosted, isCurrent, pollRun, publisher, server.name, state.status]);

  const isOpenAI = state.report
    ? isOpenAIReadinessResult(state.report)
    : publisher === "openai";

  return {
    state,
    hosted,
    isOpenAI,
    run,
    watch,
    cancel,
    loadReport,
    rediscover,
    reset,
  };
}
