import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { draftChanged, EvaluatorEditorLayout } from "./evaluator-editor-layout";
import type { RubricCheckQuestion } from "@/components/shared/session-quality/judge-config";
import {
  blankRubricCheckQuestion,
  libraryQuestionIdError,
  questionIdError,
  rubricCheckQuestionError,
  withQuestionLabel,
  withRubricChecks,
} from "../rubric-checks-model";
import { QuestionEditor } from "../rubric-checks-judge-card";
import type { EvalJudgeConfig } from "../types";
import {
  hasYesNoRubricQuestionsCapability,
  type SuiteCapabilities,
} from "@/hooks/use-suite-capabilities";
import { useEvaluatorLibraryEnabled } from "./evaluator-library-flag";

export function DecisionQuestionsSection({
  capabilities,
  judgeConfig,
  onChange,
}: {
  capabilities: Pick<SuiteCapabilities, "judges"> | null | undefined;
  judgeConfig: EvalJudgeConfig | undefined;
  onChange: (next: EvalJudgeConfig) => void;
}) {
  const canAskYesNo = hasYesNoRubricQuestionsCapability(capabilities);
  const libraryEnabled = useEvaluatorLibraryEnabled();
  const [editingId, setEditingId] = useState<string | null>(null);
  const questions = judgeConfig?.rubricChecks?.questions ?? [];
  const authored = questions.filter((question) => !question.evaluator);
  const save = (id: string, draft?: RubricCheckQuestion) => {
    const next = draft
      ? questions.map((current) => (current.id === id ? draft : current))
      : questions.filter((current) => current.id !== id);
    onChange(withRubricChecks(judgeConfig, { questions: next }));
    setEditingId((editing) => (editing === id ? null : editing));
    return undefined;
  };
  if (!libraryEnabled || authored.length === 0) return null;
  return (
    <section
      aria-label="Decision questions"
      className="rounded-lg border border-border p-3"
    >
      {/* The Rubric checks card in this stage says when these are paused. */}
      <h4 className="text-sm font-medium">Decision questions</h4>
      <ul className="divide-y divide-border">
        {authored.map((question) => (
          <li key={question.id} className="py-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium break-words">
                  {question.label}
                </p>
                <p className="text-xs break-words text-muted-foreground">
                  {question.instructions}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Edit ${question.label}`}
                  onClick={() => setEditingId(question.id)}
                >
                  <Pencil aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${question.label}`}
                  onClick={() => save(question.id)}
                >
                  <Trash2 aria-hidden />
                </Button>
              </div>
            </div>
            {editingId === question.id ? (
              <div className="mt-3">
                <DecisionEditor
                  canAskYesNo={canAskYesNo}
                  initialQuestion={question}
                  questions={questions.filter(
                    (current) => current.id !== question.id,
                  )}
                  onCancel={() => setEditingId(null)}
                  onSave={(draft) => save(question.id, draft)}
                />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

const QUESTION_TYPES = [
  { kind: "yesno", label: "Yes/no" },
  { kind: "choice", label: "Choice" },
  { kind: "score", label: "Score" },
] as const;

export function DecisionEditor({
  inDialog = false,
  pauseMessage,
  canAskYesNo,
  initialQuestion,
  questions,
  onCancel,
  onSave,
  onDirtyChange,
}: {
  inDialog?: boolean;
  pauseMessage?: string;
  canAskYesNo: boolean;
  initialQuestion?: RubricCheckQuestion;
  questions: RubricCheckQuestion[];
  onCancel: () => void;
  /** Saves the question, or says why the suite refused it. */
  onSave: (question: RubricCheckQuestion) => string | undefined;
  /** The dialog asks before closing over a changed draft. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [start] = useState(
    () =>
      initialQuestion ??
      blankRubricCheckQuestion(canAskYesNo ? "yesno" : "choice", questions),
  );
  const [question, setQuestionState] = useState(start);
  const setQuestion = (next: RubricCheckQuestion) => {
    setQuestionState(next);
    onDirtyChange?.(draftChanged(next, start));
  };
  const [original] = useState(initialQuestion);
  const [tried, setTried] = useState(false);
  // Why the suite refused the save, when the draft itself was fine.
  const [refusal, setRefusal] = useState<string>();
  const conflict = draftChanged(initialQuestion, original);
  const all = [...questions, question];
  const idError =
    libraryQuestionIdError(question, initialQuestion?.id) ??
    questionIdError(question, questions.length, all);
  const error =
    !canAskYesNo && question.kind === "yesno"
      ? "Choose Choice or Score on this deployment."
      : (idError ?? rubricCheckQuestionError(question, questions.length, all));

  return (
    <EvaluatorEditorLayout
      inDialog={inDialog}
      inlineClassName="space-y-3"
      action={initialQuestion ? "Save question" : "Add question"}
      disabled={conflict}
      error={inDialog && tried ? (error ?? refusal) : undefined}
      onCancel={onCancel}
      onSubmit={() => {
        setTried(true);
        if (!conflict && !error) setRefusal(onSave(question));
      }}
    >
      {pauseMessage ? (
        <p role="status" className="text-sm text-muted-foreground">
          {pauseMessage}
        </p>
      ) : null}
      <div
        role="group"
        aria-label="Question type"
        className="flex flex-wrap gap-2"
      >
        {QUESTION_TYPES.filter(
          ({ kind }) => canAskYesNo || kind !== "yesno",
        ).map(({ kind, label }) => (
          <Button
            key={kind}
            type="button"
            variant={question.kind === kind ? "secondary" : "outline"}
            aria-pressed={question.kind === kind}
            size="sm"
            onClick={() => {
              if (kind === question.kind) return;
              const { id, label, instructions } = question;
              setQuestion({
                ...blankRubricCheckQuestion(kind, questions),
                id,
                label,
                instructions,
              });
              setTried(false);
            }}
          >
            {label}
          </Button>
        ))}
      </div>
      <QuestionEditor
        inDialog={inDialog}
        index={0}
        question={question}
        error={tried ? error : undefined}
        idError={tried ? idError : undefined}
        disabled={false}
        onChange={setQuestion}
        onLabelChange={(label) =>
          setQuestion(withQuestionLabel(question, label, questions))
        }
      />
      {conflict ? (
        <p role="alert" className="text-sm text-destructive">
          This question changed while you were editing. Copy any edits you want
          to keep, then cancel and reopen the question.
        </p>
      ) : null}
    </EvaluatorEditorLayout>
  );
}
