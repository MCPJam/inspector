import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import {
  SESSION_QUESTIONS_API,
  type SessionQuestion,
  type SessionQuestionCatalog,
} from "@/lib/scenario-insights-api";
import type { InsightsScope, SankeyStage } from "@/hooks/useUsageInsights";
import {
  SessionFlowSankey,
  type SessionFlowSankeyProps,
} from "./SessionFlowSankey";

type ScopeArgs = { scenarioId?: string; projectId?: string };
const listQuestions = makeFunctionReference<
  "query",
  ScopeArgs,
  SessionQuestionCatalog
>(SESSION_QUESTIONS_API.list);
const saveQuestion = makeFunctionReference<
  "mutation",
  ScopeArgs & { questionId?: string; label: string; question: string },
  { questionId: string; version: number; meaningChanged: boolean }
>(SESSION_QUESTIONS_API.upsert);
const removeQuestion = makeFunctionReference<
  "mutation",
  { questionId: string },
  null
>(SESSION_QUESTIONS_API.remove);

/** One draft and one submit: changing field focus never saves a partial question. */
export function SessionQuestionEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial?: Pick<SessionQuestion, "label" | "question">;
  onSave: (draft: { label: string; question: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [question, setQuestion] = useState(initial?.question ?? "");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving.current) return;
    if (!label.trim() || !question.trim()) {
      setError("Enter a label and a yes/no question.");
      return;
    }
    saving.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await onSave({ label: label.trim(), question: question.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save question.");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !saving.current) {
          event.stopPropagation();
          onCancel();
        }
      }}
      className="flex flex-col gap-1 text-xs"
    >
      <Input
        aria-label="Column label"
        autoFocus
        value={label}
        maxLength={24}
        disabled={busy}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Column label"
        className="h-7 text-xs"
      />
      <Input
        aria-label="Yes/no question"
        value={question}
        maxLength={240}
        disabled={busy}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="Did the user…?"
        className="h-7 text-xs"
      />
      <div className="flex gap-1">
        <Button type="submit" size="sm" variant="ghost" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/** Mounted inside the workbench's boundary so an older backend keeps its flow. */
export function SessionQuestionFlow({
  scope,
  testId,
  ...props
}: SessionFlowSankeyProps & {
  scope: Exclude<InsightsScope, { kind: "benchmark" }>;
  testId: string;
}) {
  const args: ScopeArgs =
    scope.kind === "scenario"
      ? { scenarioId: scope.scenarioId }
      : { projectId: scope.projectId };
  const catalog = useQuery(listQuestions, args);
  const upsert = useMutation(saveQuestion);
  const remove = useMutation(removeQuestion);
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const headers: Partial<Record<SankeyStage, React.ReactNode>> = {};
  if (catalog)
    for (const q of catalog.questions) {
      headers[`question:${q.id}`] =
        editing === q.id && catalog.canEdit ? (
          <SessionQuestionEditor
            key={q.id}
            initial={q}
            onCancel={() => setEditing(null)}
            onSave={async (draft) => {
              await upsert({ ...args, questionId: q.id, ...draft });
              setEditing(null);
            }}
          />
        ) : (
          <div
            className="group flex items-center gap-1"
            data-testid={`${testId}-${q.id}`}
          >
            <button
              type="button"
              disabled={!catalog.canEdit}
              title={q.question}
              onClick={() => setEditing(q.id)}
              className="truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground disabled:cursor-default"
            >
              {q.label}
            </button>
            {catalog.canEdit ? (
              <button
                type="button"
                aria-label={`Remove ${q.label} column`}
                disabled={removing === q.id}
                className="shrink-0 text-muted-foreground opacity-0 hover:text-foreground focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                onClick={async () => {
                  setRemoving(q.id);
                  try {
                    await remove({ questionId: q.id });
                  } catch (err) {
                    toast.error(
                      err instanceof Error
                        ? err.message
                        : "Could not remove question.",
                    );
                  } finally {
                    setRemoving(null);
                  }
                }}
              >
                <X className="size-3" />
              </button>
            ) : null}
          </div>
        );
    }
  const create =
    catalog?.canEdit && catalog.questions.length < catalog.cap ? (
      editing === "new" ? (
        <SessionQuestionEditor
          onCancel={() => setEditing(null)}
          onSave={async (draft) => {
            await upsert({ ...args, ...draft });
            setEditing(null);
          }}
        />
      ) : (
        <button
          type="button"
          aria-label="Add question column"
          data-testid={`${testId}-add`}
          onClick={() => setEditing("new")}
          className="ml-auto flex text-muted-foreground hover:text-foreground"
        >
          <Plus className="size-4" />
        </button>
      )
    ) : undefined;
  return (
    <>
      <SessionFlowSankey
        {...props}
        questionHeaders={headers}
        questionCreate={create}
        questionEditing={editing !== null}
      />
      {catalog?.questions.length ? (
        <p
          className="shrink-0 px-5 text-xs text-muted-foreground"
          data-testid={`${testId}-coverage`}
        >
          Backfills answer up to the 500 most recent sessions. Older sessions
          may be unanswered.
        </p>
      ) : null}
    </>
  );
}
