import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
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
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { VerdictPill, type VerdictStatus } from "./verdict-pill";

type PreviewTrial = {
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

/** Preview costs a judge call, so run it only on request. */
export function CustomJudgePreview({
  inDialog = false,
  suiteId,
  judge,
  disabledReason,
}: {
  inDialog?: boolean;
  suiteId: string;
  judge: CustomJudge;
  disabledReason?: string;
}) {
  const trials = useQuery(listTrialsRef, { suiteId });
  const preview = useAction(previewRef);
  const [iterationId, setIterationId] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [completed, setCompleted] = useState<{
    input: string;
    outcome?: PreviewResult;
    failure?: string;
  } | null>(null);
  const chosen =
    trials?.find((trial) => trial.iterationId === iterationId)?.iterationId ??
    trials?.[0]?.iterationId ??
    "";
  const input = JSON.stringify({ suiteId, iterationId: chosen, judge });
  const outcome = completed?.input === input ? completed.outcome : undefined;
  const failure = completed?.input === input ? completed.failure : undefined;

  const run = async () => {
    setRunning(true);
    setCompleted(null);
    try {
      const outcome = await preview({ suiteId, iterationId: chosen, judge });
      setCompleted({ input, outcome });
    } catch (caught) {
      setCompleted({
        input,
        failure: getBillingErrorMessage(
          caught,
          "Could not test the judge. Try again.",
          false,
        ),
      });
    } finally {
      setRunning(false);
    }
  };

  const content = trials?.length === 0 ? (
    <p className="text-xs text-muted-foreground">
      Run this suite once to test a judge on a past trial.
    </p>
  ) : (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-2",
        !inDialog && "rounded-md border border-border/60 p-2.5",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Select value={chosen} onValueChange={setIterationId}>
          <SelectTrigger
            aria-label="Past trial"
            className="h-8 w-64 max-w-full text-xs"
          >
            <SelectValue placeholder="Loading trials…" />
          </SelectTrigger>
          <SelectContent>
            {(trials ?? []).map((t, index) => (
              <SelectItem key={t.iterationId} value={t.iterationId} title={t.iterationId}>
                {`Trial ${index + 1} · `}
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
          {running ? "Testing…" : inDialog ? "Run test" : "Test on a past trial"}
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
          {outcome.reason === "iteration_not_gradable"
            ? "This trial cannot be graded. Choose another trial."
            : "Could not test the judge. Check the suite's judge model and try again."}
        </p>
      ) : null}
      {outcome?.ok ? (
        <div
          role="status"
          className={cn(
            "flex min-w-0 flex-col gap-1.5 text-xs",
            inDialog && "rounded-md border border-border bg-background p-3",
          )}
        >
          <div className="flex items-center gap-2">
            <VerdictPill status={statusOf(outcome.result)} />
            {outcome.result.value !== undefined && judge.output.kind === "score" ? (
              <span className="font-mono">
                {outcome.result.value} / {judge.output.threshold}
              </span>
            ) : null}
          </div>
          <p className="text-foreground">{outcome.result.reason}</p>
          {outcome.prompt ? (
            <details>
              <summary className="cursor-pointer text-muted-foreground">
                {outcome.promptTruncated
                  ? "What the judge read (excerpt)"
                  : "What the judge read"}
              </summary>
              <pre
                className={cn(
                  "mt-1 whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[11px]",
                  inDialog ? "wrap-anywhere" : "max-h-64 overflow-auto",
                )}
              >
                {outcome.prompt}
              </pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
  if (!inDialog) return content;

  return (
    <details className="group rounded-md border border-border bg-muted/30">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-3 py-2.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
        <ChevronRight
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground group-open:rotate-90"
        />
        Test on a past trial
      </summary>
      <div className="border-t border-border p-3">{content}</div>
    </details>
  );
}
