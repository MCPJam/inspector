import { Button } from "@mcpjam/design-system/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import type { CustomJudge } from "@/components/shared/session-quality/judge-config";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { useAction, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useState } from "react";
import {
  convexErrorCode,
  customJudgeFailureCopy,
} from "./custom-judge-failure-copy";
import { VerdictPill, type VerdictStatus } from "./verdict-pill";

type PreviewIteration = {
  iterationId: string;
  runNumber: number | null;
  title: string;
  result: string | null;
  createdAt: number;
};

type PreviewResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      prompt: string | null;
      promptTruncated?: boolean;
      result: {
        status: "scored" | "error";
        value?: number;
        passed?: boolean;
        reason: string;
        error?: string;
      };
    };

const listIterationsRef = makeFunctionReference<
  "query",
  { suiteId: string },
  PreviewIteration[]
>("customJudgePreviewAuth:listCustomJudgePreviewIterations");

const previewRef = makeFunctionReference<
  "action",
  { suiteId: string; iterationId: string; judge: CustomJudge },
  PreviewResult
>("customJudgePreview:previewCustomJudge");

function statusOf(result: Extract<PreviewResult, { ok: true }>["result"]) {
  if (result.status === "error") return "error" satisfies VerdictStatus;
  return (result.passed ? "passed" : "failed") satisfies VerdictStatus;
}

/** Preview costs a judge call, so run it only on request. */
export function CustomJudgePreview({
  suiteId,
  judge,
  disabledReason,
}: {
  suiteId: string;
  judge: CustomJudge;
  disabledReason?: string;
}) {
  const iterations = useQuery(listIterationsRef, { suiteId });
  const preview = useAction(previewRef);
  const [iterationId, setIterationId] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [completed, setCompleted] = useState<{
    input: string;
    outcome?: PreviewResult;
    failure?: string;
  } | null>(null);
  const chosen =
    iterations?.find((row) => row.iterationId === iterationId)?.iterationId ??
    iterations?.[0]?.iterationId ??
    "";
  const input = JSON.stringify({ suiteId, iterationId: chosen, judge });
  const outcome = completed?.input === input ? completed.outcome : undefined;
  const failure = completed?.input === input ? completed.failure : undefined;

  if (iterations && iterations.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Run this suite once to test a judge on a past iteration.
      </p>
    );
  }

  const run = async () => {
    setRunning(true);
    setCompleted(null);
    try {
      const outcome = await preview({ suiteId, iterationId: chosen, judge });
      setCompleted({ input, outcome });
    } catch (caught) {
      setCompleted({
        input,
        failure:
          customJudgeFailureCopy(convexErrorCode(caught)) ??
          getBillingErrorMessage(
            caught,
            "Couldn't test the judge. Check the suite's judge model and try again.",
            false,
          ),
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border/60 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={chosen} onValueChange={setIterationId}>
          <SelectTrigger aria-label="Past iteration" className="h-8 w-64 text-xs">
            <SelectValue placeholder="Loading iterations…" />
          </SelectTrigger>
          <SelectContent>
            {(iterations ?? []).map((t, index) => (
              <SelectItem key={t.iterationId} value={t.iterationId} title={t.iterationId}>
                {`Iteration ${index + 1} · `}
                {t.runNumber !== null ? `Run #${t.runNumber} · ` : ""}
                {t.title}
                {t.result ? ` · ${t.result}` : ""}
                {` · ${new Date(t.createdAt).toLocaleString()}`}
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
          {running ? "Testing…" : "Test on a past iteration"}
        </Button>
        <span className="text-xs text-muted-foreground">
          Graded by the judge this run used, as one charged call. Saves nothing.
        </span>
      </div>
      {failure ? (
        <p role="alert" className="text-xs text-destructive">
          {failure}
        </p>
      ) : null}
      {outcome && !outcome.ok ? (
        <p role="status" className="text-xs text-muted-foreground">
          {customJudgeFailureCopy(outcome.reason) ??
            "Could not test the judge. Check the suite's judge model and try again."}
        </p>
      ) : null}
      {outcome?.ok ? (
        <div role="status" className="flex flex-col gap-1.5 text-xs">
          <div className="flex items-center gap-2">
            <VerdictPill status={statusOf(outcome.result)} />
            {outcome.result.value !== undefined && judge.output.kind === "score" ? (
              <span className="font-mono">
                {outcome.result.value} / {judge.output.threshold}
              </span>
            ) : null}
          </div>
          <p className="text-foreground">
            {outcome.result.reason ||
              customJudgeFailureCopy(outcome.result.error) ||
              "The judge couldn't grade this iteration. Choose another iteration and try again."}
          </p>
          {outcome.prompt ? (
            <details>
              <summary className="cursor-pointer text-muted-foreground">
                {outcome.promptTruncated
                  ? "What the judge read (excerpt)"
                  : "What the judge read"}
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
