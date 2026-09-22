import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  SendHorizontal,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Textarea } from "@mcpjam/design-system/textarea";
import { cn } from "@/lib/utils";
import type { EvalCase } from "../evals/types";
import { buildSuiteTestCaseRows } from "./suite-detail-model";

export type RefinementMessage = {
  id: number;
  role: "assistant" | "user";
  text: string;
};

export type GenerationCaseRow = {
  caseId: string;
  title: string;
  summary: string;
  selected?: boolean;
  requiresSetup?: boolean;
};

export function SuiteCaseGenerationWorkspace({
  suiteName,
  cases = [],
  caseRows,
  isGenerating,
  onGenerate,
  onCaseClick,
  onClose,
  onBack,
  onToggleCase,
  onRemoveCase,
  conversation,
  title = "Generating test cases",
  doneLabel = "Done",
  backLabel = "Suite",
  doneDisabled = false,
  refinementDisabledReason,
  generationStatus = "Drafting from live server discovery…",
}: {
  suiteName: string;
  cases?: EvalCase[];
  caseRows?: GenerationCaseRow[];
  conversation?: RefinementMessage[];
  title?: string;
  doneLabel?: string;
  backLabel?: string;
  doneDisabled?: boolean;
  refinementDisabledReason?: string;
  generationStatus?: string;
  onBack?: () => void;
  onToggleCase?: (caseId: string) => void;
  onRemoveCase?: (caseId: string) => void;
  isGenerating: boolean;
  onGenerate: (refinement?: string) => Promise<void> | void;
  onCaseClick: (testCaseId: string) => void;
  onClose: () => void;
}) {
  const initialCaseIdsRef = useRef(
    new Set(
      caseRows
        ? caseRows.map((row) => row.caseId)
        : cases.map((testCase) => testCase._id),
    ),
  );
  const [draft, setDraft] = useState("");
  const [refining, setRefining] = useState(false);
  const nextMessageId = useRef(1);
  const [messages, setMessages] = useState<RefinementMessage[]>([
    {
      id: 0,
      role: "assistant",
      text: "I’m discovering your servers and drafting test cases. Once they appear, tell me what to add or make more specific.",
    },
  ]);
  const rows: GenerationCaseRow[] = useMemo(
    () => caseRows ?? buildSuiteTestCaseRows(cases),
    [caseRows, cases],
  );
  const busy = isGenerating || refining;
  const conversationRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const panel = conversationRef.current;
    if (panel) panel.scrollTop = panel.scrollHeight;
  }, [conversation, messages, busy]);
  const generatedCount = rows.filter(
    (row) => !initialCaseIdsRef.current.has(row.caseId),
  ).length;

  const handleSubmit = async () => {
    const refinement = draft.trim();
    if (!refinement || busy || refinementDisabledReason) return;

    const userMessage: RefinementMessage = {
      id: nextMessageId.current++,
      role: "user",
      text: refinement,
    };
    setMessages((current) => [...current, userMessage]);
    setDraft("");
    setRefining(true);
    try {
      await onGenerate(refinement);
      setMessages((current) => [
        ...current,
        {
          id: nextMessageId.current++,
          role: "assistant",
          text: "The refinement pass is complete. Review the updated case list or describe another change.",
        },
      ]);
    } catch {
      setMessages((current) => [
        ...current,
        {
          id: nextMessageId.current++,
          role: "assistant",
          text: "I couldn’t apply that refinement. Try a shorter, more specific direction.",
        },
      ]);
    } finally {
      setRefining(false);
    }
  };

  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background"
      data-testid="suite-case-generation-workspace"
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 px-2"
            onClick={onBack ?? onClose}
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            {backLabel}
          </Button>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground">
              {title}
            </h2>
            <p className="truncate text-xs text-muted-foreground">
              {suiteName}
            </p>
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          className="h-8"
          disabled={doneDisabled || busy}
          onClick={onClose}
        >
          {doneLabel}
        </Button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1.15fr)_minmax(20rem,0.85fr)]">
        <div className="flex min-h-0 flex-col border-b border-border md:border-b-0 md:border-r">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-5 py-3.5">
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                Test cases
              </h3>
              <p className="text-xs text-muted-foreground">
                {busy
                  ? generationStatus
                  : generatedCount > 0
                  ? `${generatedCount} new ${
                      generatedCount === 1 ? "case" : "cases"
                    } generated`
                  : `${rows.length} ${rows.length === 1 ? "case" : "cases"}`}
              </p>
            </div>
            {busy ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                Generating
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-xs text-success">
                <CheckCircle2 className="size-3.5" aria-hidden />
                {rows.length ? "Ready" : "No cases yet"}
              </span>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {rows.length > 0 ? (
              <ul className="space-y-2">
                {rows.map((row) => {
                  const isNew = !initialCaseIdsRef.current.has(row.caseId);
                  return (
                    <li key={row.caseId} className="flex items-center gap-2">
                      {onToggleCase && (
                        <input
                          type="checkbox"
                          checked={row.selected !== false}
                          onChange={() => onToggleCase(row.caseId)}
                          aria-label={`Include ${row.title}`}
                          disabled={busy}
                        />
                      )}
                      <button
                        type="button"
                        className="flex w-full items-start gap-3 rounded-lg border border-border bg-card px-3.5 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none"
                        disabled={busy}
                        onClick={() => onCaseClick(row.caseId)}
                      >
                        <span
                          className={cn(
                            "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md",
                            isNew
                              ? "bg-primary/10 text-primary"
                              : "bg-muted text-muted-foreground",
                          )}
                        >
                          <Sparkles className="size-3.5" aria-hidden />
                        </span>
                        <span className="min-w-0">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium text-foreground">
                              {row.title}
                            </span>
                            {isNew ? (
                              <span className="rounded-sm bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                                New
                              </span>
                            ) : null}
                          </span>
                          {row.requiresSetup && (
                            <span className="mt-1 block text-xs text-muted-foreground">
                              Needs a test environment · may change data
                            </span>
                          )}
                          {row.summary ? (
                            <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                              {row.summary}
                            </span>
                          ) : null}
                        </span>
                      </button>
                      {onRemoveCase && (
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={busy}
                          aria-label={`Remove ${row.title}`}
                          onClick={() => onRemoveCase(row.caseId)}
                        >
                          <Trash2 className="size-3.5" aria-hidden />
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : busy ? (
              <GenerationSkeletons />
            ) : (
              <div className="flex h-full min-h-48 items-center justify-center px-6 text-center">
                <div>
                  <Sparkles
                    className="mx-auto size-5 text-muted-foreground"
                    aria-hidden
                  />
                  <p className="mt-2 text-sm font-medium text-foreground">
                    No cases were generated
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Describe a more specific direction in the chat.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex min-h-[24rem] flex-col bg-muted/20 md:min-h-0">
          <div className="shrink-0 border-b border-border/60 px-5 py-3.5">
            <h3 className="text-sm font-semibold text-foreground">
              Refine with AI
            </h3>
            <p className="text-xs text-muted-foreground">
              Shape coverage, user intent, edge cases, or complexity.
            </p>
          </div>

          <div
            className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4"
            aria-live="polite"
            ref={conversationRef}
          >
            {(conversation ?? messages).map((message) => (
              <div
                key={message.id}
                className={cn(
                  "max-w-[88%] rounded-lg px-3 py-2 text-sm leading-relaxed",
                  message.role === "user"
                    ? "ml-auto bg-primary/10 text-foreground"
                    : "border border-border bg-card text-foreground",
                )}
              >
                {message.text}
              </div>
            ))}
            {busy ? (
              <div className="flex max-w-[88%] items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                {refining ? "Applying your refinement…" : generationStatus}
              </div>
            ) : null}
          </div>

          <form
            className="shrink-0 border-t border-border bg-background p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSubmit();
            }}
          >
            <div className="rounded-lg border border-border bg-background p-2 focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]">
              <Textarea
                disabled={Boolean(refinementDisabledReason)}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void handleSubmit();
                  }
                }}
                placeholder="e.g. Add failure cases for expired credentials"
                aria-label="Describe test case refinements"
                className="min-h-20 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0"
              />
              <div className="flex items-center justify-between gap-3 px-1 pt-1">
                <span className="text-[11px] text-muted-foreground">
                  {refinementDisabledReason ??
                    "Enter to send · Shift+Enter for a new line"}
                </span>
                <Button
                  type="submit"
                  size="icon"
                  className="size-8 shrink-0"
                  disabled={
                    !draft.trim() || busy || Boolean(refinementDisabledReason)
                  }
                  aria-label="Send refinement"
                >
                  {refining ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  ) : (
                    <SendHorizontal className="size-3.5" aria-hidden />
                  )}
                </Button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </section>
  );
}

function GenerationSkeletons() {
  return (
    <div className="space-y-2" aria-label="Generating test cases">
      {[0, 1, 2, 3].map((index) => (
        <div
          key={index}
          className="flex items-start gap-3 rounded-lg border border-border bg-card px-3.5 py-3"
        >
          <div className="size-7 shrink-0 animate-pulse rounded-md bg-muted" />
          <div className="min-w-0 flex-1 space-y-2 py-0.5">
            <div
              className={cn(
                "h-3.5 animate-pulse rounded-sm bg-muted",
                index % 2 === 0 ? "w-2/3" : "w-1/2",
              )}
            />
            <div className="h-3 w-4/5 animate-pulse rounded-sm bg-muted/70" />
          </div>
        </div>
      ))}
    </div>
  );
}
