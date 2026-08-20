/**
 * One directory-readiness run — local or hosted — as a hook.
 *
 * Rendering stays with the panel; this owns the state machine, which is the
 * part that is easy to get subtly wrong:
 *
 *   - A LOCAL run resolves once and is done. There is no row, no poll and no
 *     cancel, because nothing outlives the request.
 *   - A HOSTED run starts with a `202` and then lives on a server. The panel
 *     polls it, and it can end `completed`, `failed` or `cancelled` — three
 *     outcomes a single boolean would collapse.
 *
 * WHY THE OBSERVATION AXIS IS SEPARATE FROM THE RUN'S STATUS. A run whose
 * lanes graded cleanly is `completed` even when the model call was refused for
 * credit; the refusal lives on `llmObservations.status` and is reported beside
 * the grade rather than instead of it. Folding the two would make a billing
 * outage look like a grading failure, which is the one reading that would send
 * a user to fix their server.
 *
 * WHY READINESS IS NOT POOLED WITH THE CONFORMANCE SUITES. Readiness answers
 * "would this be listed", not "how good is this". It has no numerator, and
 * mixing a lane verdict into `pooledConformanceScore` would invent one.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { OpenAISubmissionMode } from "@mcpjam/sdk/browser";
import type { ServerWithName } from "@/hooks/use-app-state";
import {
  cancelHostedReadinessRun,
  canRequestModelObservations,
  getHostedReadinessReport,
  getHostedReadinessRun,
  startDirectoryReadiness,
  type HostedReadinessRun,
  type ReadinessPublisher,
  type ReadinessResult,
} from "@/lib/apis/mcp-readiness-api";

export type ReadinessRunStatus =
  | "idle"
  | "starting"
  | "running"
  | "done"
  | "cancelled"
  | "error"
  | "unavailable";

export interface DirectoryReadinessState {
  status: ReadinessRunStatus;
  /** Present on `done` for both modes: the graded result, findings included. */
  result?: ReadinessResult;
  /** Hosted only — the durable row, which carries the observation axis. */
  run?: HostedReadinessRun;
  error?: string;
  unavailableReason?: string;
}

/** How often a hosted run is polled while it is in flight. */
const POLL_INTERVAL_MS = 2_000;

/**
 * How long the panel will poll before giving up on its own.
 *
 * NOT a cancellation: the run keeps going server-side and the row stays
 * readable. This only stops the tab from polling forever when a user leaves it
 * open on a run whose node died — the recovery cron is what actually resolves
 * that, on a slower clock than a person watching a spinner will tolerate.
 */
const POLL_CEILING_MS = 16 * 60_000;

function isTerminal(status: HostedReadinessRun["status"]): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

export interface UseDirectoryReadinessOptions {
  server: ServerWithName;
  publisher: ReadinessPublisher;
}

export function useDirectoryReadiness({
  server,
  publisher,
}: UseDirectoryReadinessOptions) {
  const [state, setState] = useState<DirectoryReadinessState>({
    status: "idle",
  });
  const [submissionMode, setSubmissionMode] = useState<
    OpenAISubmissionMode | undefined
  >(publisher === "openai" ? "mcp-only" : undefined);
  /**
   * The billed opt-in, DEFAULT OFF.
   *
   * Deterministic readiness is the product; observations are an extra that
   * spends an organization's MCPJam credits. A default of `true` would make
   * every existing user start paying the day this shipped.
   */
  const [includeLlmObservations, setIncludeLlmObservations] = useState(false);

  // One generation counter guards every async write. A user who restarts a run
  // while the previous one is still resolving must not have the old run's
  // result land on top of the new one's — and on a poll loop that is not a
  // rare race, it is the normal case.
  const generation = useRef(0);
  const activeRunId = useRef<string | null>(null);

  useEffect(() => {
    // Switching server or publisher makes the current run's result belong to
    // something the panel is no longer showing.
    generation.current += 1;
    activeRunId.current = null;
    setState({ status: "idle" });
  }, [server.name, publisher]);

  useEffect(() => {
    // Unmount invalidates in-flight work for the same reason.
    return () => {
      generation.current += 1;
    };
  }, []);

  const observationsAvailable = canRequestModelObservations();

  const pollHostedRun = useCallback(async (runId: string, mine: number) => {
    const deadline = Date.now() + POLL_CEILING_MS;

    for (;;) {
      if (mine !== generation.current) return;
      if (Date.now() > deadline) {
        setState((prior) => ({
          ...prior,
          status: "error",
          error:
            "Stopped watching this run after 16 minutes. It may still be running — reopen this tab to check.",
        }));
        return;
      }

      let row: HostedReadinessRun;
      try {
        row = await getHostedReadinessRun(runId);
      } catch (error) {
        if (mine !== generation.current) return;
        setState({
          status: "error",
          error:
            error instanceof Error ? error.message : "Could not read the run",
        });
        return;
      }
      if (mine !== generation.current) return;

      if (!isTerminal(row.status)) {
        // Publish the row on every tick, not just at the end: the lane
        // statuses fill in as stages finish, and a spinner that showed
        // nothing until the last moment would hide a run that is working.
        setState({ status: "running", run: row });
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      if (row.status === "cancelled") {
        setState({ status: "cancelled", run: row });
        return;
      }
      if (row.status === "failed") {
        setState({
          status: "error",
          run: row,
          error:
            row.errorMessage ??
            "The readiness run did not finish. Try running it again.",
        });
        return;
      }

      // Completed. The row carries lane statuses and the observation axis;
      // the findings live in the report, which is fetched separately because
      // it can reach megabytes.
      let result: ReadinessResult | undefined;
      if (row.hasReport) {
        try {
          result = await getHostedReadinessReport(runId);
        } catch {
          // A missing report is not a failed run: the lanes on the row are
          // still a real verdict, and saying "run failed" here would be
          // false. The panel renders coverage without per-finding detail.
          result = undefined;
        }
      }
      if (mine !== generation.current) return;
      setState({ status: "done", run: row, result });
      return;
    }
  }, []);

  const run = useCallback(async () => {
    const mine = ++generation.current;
    activeRunId.current = null;
    setState({ status: "starting" });

    try {
      const outcome = await startDirectoryReadiness({
        serverNameOrId: server.name,
        publisher,
        submissionMode: publisher === "openai" ? submissionMode : undefined,
        // Never sent unless this build can actually honour it: a local run has
        // no broker, and a flag it cannot act on would read as "asked for and
        // silently dropped".
        includeLlmObservations: observationsAvailable && includeLlmObservations,
      });

      if (mine !== generation.current) return;

      if (outcome.mode === "local") {
        setState({ status: "done", result: outcome.result });
        return;
      }

      activeRunId.current = outcome.receipt.runId;
      setState({ status: "running" });
      await pollHostedRun(outcome.receipt.runId, mine);
    } catch (error) {
      if (mine !== generation.current) return;
      setState({
        status: "error",
        error: error instanceof Error ? error.message : "Readiness run failed",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    server.name,
    publisher,
    submissionMode,
    includeLlmObservations,
    observationsAvailable,
  ]);

  const cancel = useCallback(async () => {
    const runId = activeRunId.current;
    if (!runId) return;
    try {
      await cancelHostedReadinessRun(runId);
    } catch {
      // The poll loop is what reports the outcome. A cancel that failed to
      // register leaves the run going, and the row will say so — inventing an
      // error here would contradict it.
    }
  }, []);

  return {
    state,
    run,
    cancel,
    submissionMode,
    setSubmissionMode,
    includeLlmObservations,
    setIncludeLlmObservations,
    /** False on local builds: there is no broker, lease or payer to spend. */
    observationsAvailable,
    isRunning: state.status === "starting" || state.status === "running",
    /** Only a hosted run can be stopped; a local one has already returned. */
    canCancel: state.status === "running" && activeRunId.current !== null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
