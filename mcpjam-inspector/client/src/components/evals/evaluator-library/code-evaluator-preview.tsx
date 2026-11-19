import { Button } from "@mcpjam/design-system/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useState } from "react";
import { useConvexAccessToken } from "@/hooks/use-convex-access-token";
import { authFetch } from "@/lib/session-token";
import { VerdictPill } from "./verdict-pill";

type PreviewTrial = {
  iterationId: string;
  runNumber: number | null;
  title: string;
  result: string | null;
};

type Outcome = {
  status: "scored" | "error";
  pass?: boolean;
  reason: string;
  logs?: string;
};

const listTrialsRef = makeFunctionReference<
  "query",
  { suiteId: string },
  PreviewTrial[]
>("customJudgePreviewAuth:listCustomJudgePreviewTrials");

/**
 * "Test on a past run" for code: runs the draft on one stored trial in the
 * sandbox runner and shows the outcome and logs. Saves nothing.
 */
export function CodeEvaluatorPreview({
  suiteId,
  source,
  disabledReason,
}: {
  suiteId: string;
  source: string;
  /** Set while the draft would be refused on save. */
  disabledReason?: string;
}) {
  const trials = useQuery(listTrialsRef, { suiteId });
  const getToken = useConvexAccessToken();
  const [iterationId, setIterationId] = useState("");
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const chosen = iterationId || trials?.[0]?.iterationId || "";

  if (trials && trials.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Run this suite once to test code on a past trial.
      </p>
    );
  }

  const run = async () => {
    setRunning(true);
    setFailure(null);
    try {
      const convexAuthToken = await getToken();
      const response = await authFetch("/api/mcp/evals/code-evaluator-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ convexAuthToken, iterationId: chosen, source }),
      });
      const body = (await response.json()) as { outcome?: Outcome; error?: string };
      if (!response.ok || !body.outcome) {
        setFailure(body.error ?? "Could not test the code. Try again.");
        setOutcome(null);
      } else {
        setOutcome(body.outcome);
      }
    } catch {
      setFailure("Could not test the code. Try again.");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border/60 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={chosen} onValueChange={setIterationId}>
          <SelectTrigger aria-label="Past trial" className="h-8 w-64 text-xs">
            <SelectValue placeholder="Loading trials…" />
          </SelectTrigger>
          <SelectContent>
            {(trials ?? []).map((t) => (
              <SelectItem key={t.iterationId} value={t.iterationId}>
                {t.runNumber !== null ? `Run #${t.runNumber} · ` : ""}
                {t.title}
                {t.result ? ` · ${t.result}` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!chosen || running || Boolean(disabledReason)}
          title={disabledReason}
          onClick={run}
        >
          {running ? "Testing…" : "Test on a past run"}
        </Button>
        <span className="text-xs text-muted-foreground">Saves nothing.</span>
      </div>
      {failure ? (
        <p role="alert" className="text-xs text-destructive">
          {failure}
        </p>
      ) : null}
      {outcome ? (
        <div role="status" className="flex flex-col gap-1.5 text-xs">
          <VerdictPill
            status={
              outcome.status === "error" ? "error" : outcome.pass ? "passed" : "failed"
            }
          />
          <p className="text-foreground">{outcome.reason}</p>
          {outcome.logs ? (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[11px]">
              {outcome.logs}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
