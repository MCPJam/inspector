import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
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
import { stageOrderStorageKey } from "./sankey-stage-order";

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
  submitLabel = "Save",
}: {
  initial?: Pick<SessionQuestion, "label" | "question">;
  onSave: (draft: { label: string; question: string }) => Promise<void>;
  onCancel: () => void;
  submitLabel?: string;
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
      className="flex flex-col gap-4"
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="session-question-label">Column label</Label>
        <Input
          id="session-question-label"
          aria-label="Column label"
          autoFocus
          value={label}
          maxLength={24}
          disabled={busy}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Auth wall"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="session-question-text">Yes/no question</Label>
        <Input
          id="session-question-text"
          aria-label="Yes/no question"
          value={question}
          maxLength={240}
          disabled={busy}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Did the user…?"
        />
      </div>
      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? (submitLabel === "Add" ? "Adding…" : "Saving…") : submitLabel}
        </Button>
      </DialogFooter>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function SessionQuestionDialog({
  open,
  onOpenChange,
  onSave,
  initial,
  title,
  submitLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (draft: { label: string; question: string }) => Promise<void>;
  initial?: Pick<SessionQuestion, "label" | "question">;
  title: string;
  submitLabel: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Answers are only Yes or No. Write the question so a session can be
            scored that way.
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <SessionQuestionEditor
            key={title}
            initial={initial}
            submitLabel={submitLabel}
            onSave={onSave}
            onCancel={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
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
      headers[`question:${q.id}`] = (
        <div
          className="group flex items-center gap-1"
          data-testid={`${testId}-${q.id}`}
        >
          <button
            type="button"
            disabled={!catalog.canEdit}
            title={q.question}
            onClick={() => setEditing(q.id)}
            className="truncate text-xs font-semibold uppercase tracking-wider text-current disabled:cursor-default"
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
  const canAddQuestion =
    Boolean(catalog?.canEdit) &&
    (catalog?.questions.length ?? 0) < (catalog?.cap ?? 0);
  const editingQuestion =
    editing && editing !== "new"
      ? catalog?.questions.find((q) => q.id === editing)
      : undefined;
  const dialogOpen = editing === "new" || Boolean(editingQuestion);
  return (
    <>
      <SessionFlowSankey
        {...props}
        stageOrderKey={props.stageOrderKey ?? stageOrderStorageKey(scope)}
        questionHeaders={headers}
        onAddQuestion={canAddQuestion ? () => setEditing("new") : undefined}
      />
      <SessionQuestionDialog
        key={editing ?? "closed"}
        open={dialogOpen}
        initial={editingQuestion}
        title={
          editing === "new" ? "Add a yes/no question" : "Edit a yes/no question"
        }
        submitLabel={editing === "new" ? "Add" : "Save"}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        onSave={async (draft) => {
          await upsert({
            ...args,
            ...(editingQuestion ? { questionId: editingQuestion.id } : {}),
            ...draft,
          });
          setEditing(null);
        }}
      />
    </>
  );
}
