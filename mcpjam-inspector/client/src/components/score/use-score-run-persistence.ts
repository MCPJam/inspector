import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { useConformanceRun } from "@/hooks/use-conformance-run";
import { submitScoreRun } from "@/lib/apis/score-api";
import type { ServerWithName } from "@/state/app-types";
import type { ScoreRunnerPhase } from "./score-runner-view-model";
import { buildScoreRunSubmission } from "./score-run-report";

type ConformanceRun = ReturnType<typeof useConformanceRun>;

interface ScoreRunPersistenceOptions {
  phase: ScoreRunnerPhase;
  setPhase: Dispatch<SetStateAction<ScoreRunnerPhase>>;
  server: ServerWithName | null;
  run: ConformanceRun;
  setError: Dispatch<SetStateAction<string | null>>;
  setResultToken: Dispatch<SetStateAction<string | null>>;
}

function getServerUrl(server: ServerWithName | null): string | null {
  return (server?.config as { url?: string } | undefined)?.url ?? null;
}

export function useScoreRunPersistence({
  phase,
  setPhase,
  server,
  run,
  setError,
  setResultToken,
}: ScoreRunPersistenceOptions) {
  const runRef = useRef(run);
  runRef.current = run;

  const persistedRunRef = useRef<string | null>(null);
  const persistedOAuthStatusRef = useRef<string | null>(null);
  const oauthResaveAttemptsRef = useRef(0);
  const oauthResaveInFlightRef = useRef(false);

  const persistRun = useCallback(
    async (serverUrl: string) => {
      const current = runRef.current;
      const submission = buildScoreRunSubmission(serverUrl, current);
      if (!submission) {
        setPhase("done");
        return;
      }

      setPhase("saving");
      try {
        const { token } = await submitScoreRun(submission);
        setResultToken(token);
        if (
          current.oauth.status === "done" &&
          current.oauthScore !== undefined
        ) {
          persistedOAuthStatusRef.current = current.oauth.status;
        }
      } catch (error) {
        setError(
          error instanceof Error
            ? `Scan finished, but the shareable link could not be saved: ${error.message}`
            : "Scan finished, but the shareable link could not be saved.",
        );
      } finally {
        setPhase("done");
      }
    },
    [setError, setPhase, setResultToken],
  );

  useEffect(() => {
    if (phase !== "run-complete" || !server) return;
    const serverUrl = getServerUrl(server);
    if (!serverUrl) {
      setPhase("done");
      return;
    }
    if (persistedRunRef.current === server.name) return;

    persistedRunRef.current = server.name;
    void persistRun(serverUrl);
  }, [phase, persistRun, server, setPhase]);

  useEffect(() => {
    if (phase !== "done") return;
    const serverUrl = getServerUrl(server);
    if (!serverUrl) return;

    const oauthSettled =
      run.oauth.status === "done" && run.oauthScore !== undefined;
    if (!oauthSettled) return;
    if (persistedOAuthStatusRef.current === run.oauth.status) return;
    if (oauthResaveInFlightRef.current) return;
    if (oauthResaveAttemptsRef.current >= 1) return;

    oauthResaveAttemptsRef.current += 1;
    oauthResaveInFlightRef.current = true;
    void persistRun(serverUrl).finally(() => {
      oauthResaveInFlightRef.current = false;
    });
  }, [phase, persistRun, run.oauth.status, run.oauthScore, server]);

  const resetPersistence = useCallback(() => {
    persistedRunRef.current = null;
    persistedOAuthStatusRef.current = null;
    oauthResaveAttemptsRef.current = 0;
    oauthResaveInFlightRef.current = false;
  }, []);

  return resetPersistence;
}
