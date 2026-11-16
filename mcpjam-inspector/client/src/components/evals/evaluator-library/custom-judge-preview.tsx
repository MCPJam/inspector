import { Button } from "@mcpjam/design-system/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import type { CustomJudge } from "@/components/shared/session-quality/judge-config";
import { useAction, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useState } from "react";
import { VerdictPill, type VerdictStatus } from "./verdict-pill";

type PreviewTrial = {
  iterationId: string;
  runNumber: number | null;
  title: string;
  result: string | null;
};

type PreviewResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      prompt: string | null;
      result: {
        status: "scored" | "error";
        value?: number;
        passed?: boolean;
        reason: string;
        error?: string;
      };
    };

const listTrialsRef = makeFunctionReference<
  "query",
  { suiteId: string },
  PreviewTrial[]
>("customJudgePreviewAuth:listCustomJudgePreviewTrials");

const previewRef = makeFunctionReference<
  "action",
  { suiteId: string; iterationId: string; judge: CustomJudge },
  PreviewResult
>("customJudgePreview:previewCustomJudge");

function statusOf(result: Extract<PreviewResult, { ok: true }>["result"]) {
  if (result.status === "error") return "error" satisfies VerdictStatus;
  return (result.passed ? "passed" : "failed") satisfies VerdictStatus;
}

/**
 * "Test on a past run": grades one stored trial with the judge as it is in
 * the editor, before saving. It spends a judge call and writes nothing, so it
 * runs only on the button, never on mount or on edit.
 */
export function CustomJudgePreview({
  suiteId,
  judge,
  disabledReason,
}: {
  suiteId: string;
  judge: CustomJudge;
  /** Set while the draft would be refused, so the call is not wasted. */
  disabledReason?: string;
}) {
  const trials = useQuery(listTrialsRef, { suiteId });
  const preview = useAction(previewRef);
  const [iterationId, setIterationId] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<PreviewResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const chosen = iterationId || trials?.[0]?.iterationId || "";

  if (trials && trials.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Run this suite once to test a judge on a past trial.
      </p>
    );
  }

  const run = async () => {
    setRunning(true);
    setFailure(null);
    try {
      setOutcome(await preview({ suiteId, iterationId: chosen, judge }));
    } catch (caught) {
      setFailure(
        caught instanceof Error && caught.message
          ? caught.message
          : "The test could not run.",
      );
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
        <span className="text-xs text-muted-foreground">
          Uses one judge call. Saves nothing.
        </span>
      </div>
      {failure ? (
        <p role="alert" className="text-xs text-destructive">
          {failure}
        </p>
      ) : null}
      {outcome && !outcome.ok ? (
        <p role="status" className="text-xs text-muted-foreground">
          The test could not run: {outcome.reason}
        </p>
      ) : null}
      {outcome?.ok ? (
        <div role="status" className="flex flex-col gap-1.5 text-xs">
          <div className="flex items-center gap-2">
            <VerdictPill status={statusOf(outcome.result)} />
            {outcome.result.value !== undefined && judge.output.kind === "score" ? (
              <span className="font-mono">
                {outcome.result.value.toFixed(2)} / {judge.output.threshold}
              </span>
            ) : null}
          </div>
          <p className="text-foreground">{outcome.result.reason}</p>
          {outcome.prompt ? (
            <details>
              <summary className="cursor-pointer text-muted-foreground">
                What the judge read
              </summary>
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[11px]">
                {outcome.prompt}
              </pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
