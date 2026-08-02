/**
 * Renders a `ui_ask_user` tool part as an inline clarifying-question card.
 *
 * INLINE, not a modal, for the same reason the agent's `Chat` instance lives
 * outside React: the surface painting this card can be replaced mid-question
 * (Home takeover → side panel on a navigation handoff). A modal owned by a
 * route would take the question with it; a card that reads a module-scoped
 * store simply re-renders wherever the conversation lands.
 *
 * Three states, and the source of truth differs per state:
 *   pending  — the store has a parked question; the card is interactive.
 *   answered — the tool part carries an output; read the answer back from it
 *              so a reloaded transcript shows what was chosen.
 *   expired  — neither. Only reachable after a reload (the paused turn died
 *              with the previous page; the server never persisted it), so the
 *              card states that plainly instead of offering dead buttons.
 */
import { useCallback, useMemo, useState } from "react";
import { Check, HelpCircle } from "lucide-react";

import { cn } from "@/lib/chat-utils";
import {
  answerAskUserQuestion,
  useAskUserPendingQuestion,
  type AskUserOption,
} from "@/lib/webmcp/ask-user-store";

/**
 * The answer as recorded in the transcript. Mirrors what the tool returned
 * (`okResult` wraps it as `{ok, data}` inside a text content block), read
 * defensively: a shape we don't recognize degrades to the neutral "answered"
 * row rather than throwing inside a thread render.
 */
interface RecordedAnswer {
  kind: "selected" | "freeText" | "dismissed";
  label?: string;
}

function readRecordedAnswer(output: unknown): RecordedAnswer | null {
  const content = (output as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return null;
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (first?.type !== "text" || typeof first.text !== "string") return null;
  try {
    const parsed = JSON.parse(first.text) as {
      data?: { kind?: unknown; label?: unknown };
    };
    const kind = parsed?.data?.kind;
    if (kind !== "selected" && kind !== "freeText" && kind !== "dismissed") {
      return null;
    }
    return {
      kind,
      ...(typeof parsed.data?.label === "string"
        ? { label: parsed.data.label }
        : {}),
    };
  } catch {
    return null;
  }
}

/** The question text, read off the tool part's input for the settled states. */
function readQuestionText(input: unknown): string | null {
  const question = (input as { question?: unknown } | null)?.question;
  return typeof question === "string" && question.trim().length > 0
    ? question
    : null;
}

function CardShell({
  question,
  children,
}: {
  question: string | null;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/20 p-3"
      data-testid="ask-user-card"
    >
      {question ? (
        <div className="flex items-start gap-2">
          <HelpCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="text-[13px] font-medium text-foreground">
            {question}
          </span>
        </div>
      ) : null}
      {children}
    </div>
  );
}

function PendingCard({
  toolCallId,
  question,
  options,
}: {
  toolCallId: string;
  question: string;
  options: AskUserOption[];
}) {
  const [freeText, setFreeText] = useState("");
  const [showFreeText, setShowFreeText] = useState(false);

  const choose = useCallback(
    (option: AskUserOption) => {
      // The store's settle() is one-shot, so a double-click resolves once —
      // no local "submitting" flag needed to keep the turn honest.
      answerAskUserQuestion(toolCallId, {
        kind: "selected",
        value: option.value,
        label: option.label,
      });
    },
    [toolCallId],
  );

  const submitFreeText = useCallback(() => {
    const trimmed = freeText.trim();
    if (!trimmed) return;
    answerAskUserQuestion(toolCallId, { kind: "freeText", text: trimmed });
  }, [freeText, toolCallId]);

  return (
    <CardShell question={question}>
      <div className="flex flex-col gap-1">
        {options.map((option, index) => (
          <button
            key={option.value}
            type="button"
            onClick={() => choose(option)}
            className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-foreground transition-colors hover:bg-foreground/5 cursor-pointer"
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-foreground/10 text-[11px] tabular-nums text-muted-foreground">
              {index + 1}
            </span>
            {option.label}
          </button>
        ))}

        {/*
          The escape hatch is never optional: a closed set of choices would let
          the agent force one of its own guesses on a user whose actual intent
          isn't on the list. The tool description tells the model not to add
          its own "Something else" — this row IS that option, always present.
        */}
        {showFreeText ? (
          <div className="flex items-center gap-2 px-2 py-1.5">
            <input
              autoFocus
              value={freeText}
              onChange={(event) => setFreeText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitFreeText();
                }
              }}
              placeholder="Tell the assistant what you meant…"
              aria-label="Answer in your own words"
              className="min-w-0 flex-1 rounded-md border border-border/60 bg-background px-2 py-1 text-[13px] outline-none focus:border-primary/60"
            />
            <button
              type="button"
              onClick={submitFreeText}
              disabled={freeText.trim().length === 0}
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary px-3 py-1 text-[12px] font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              Send
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowFreeText(true)}
            className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground cursor-pointer"
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-foreground/10 text-[11px] tabular-nums text-muted-foreground">
              {options.length + 1}
            </span>
            Something else
          </button>
        )}
      </div>
    </CardShell>
  );
}

function SettledCard({
  question,
  answer,
}: {
  question: string | null;
  answer: RecordedAnswer | null;
}) {
  const text = useMemo(() => {
    if (!answer) return "Answered";
    if (answer.kind === "selected") return answer.label ?? "Answered";
    if (answer.kind === "freeText") return "Answered in their own words";
    return "No answer — the assistant continued on its best interpretation";
  }, [answer]);
  const muted = !answer || answer.kind !== "selected";

  return (
    <CardShell question={question}>
      <div
        className={cn(
          "flex items-center gap-2 px-2 text-[13px]",
          muted ? "text-muted-foreground" : "text-foreground",
        )}
        data-testid="ask-user-answer"
      >
        {answer?.kind === "dismissed" ? null : (
          <Check className="h-3.5 w-3.5 shrink-0 text-success" />
        )}
        {text}
      </div>
    </CardShell>
  );
}

export function AskUserPart({
  toolCallId,
  input,
  output,
  hasOutput,
  interactive = true,
}: {
  toolCallId: string | undefined;
  input: unknown;
  output: unknown;
  /**
   * Whether the tool part reached a terminal output state. Passed explicitly
   * rather than inferred from `output` being truthy: the distinction between
   * "no answer yet" and "answered" decides whether the card is interactive,
   * and an output that failed to parse must still count as settled.
   */
  hasOutput: boolean;
  /** False on read-only renders (eval replay, shared transcripts). */
  interactive?: boolean;
}) {
  const pending = useAskUserPendingQuestion(toolCallId);
  const questionText = readQuestionText(input);

  if (pending && interactive && !hasOutput && toolCallId) {
    return (
      <PendingCard
        toolCallId={toolCallId}
        question={pending.question}
        options={pending.options}
      />
    );
  }

  if (hasOutput) {
    return (
      <SettledCard
        question={questionText}
        answer={readRecordedAnswer(output)}
      />
    );
  }

  // Nothing parked and no output: this transcript was hydrated after a reload
  // that killed the paused turn. Say so rather than render dead buttons.
  return (
    <CardShell question={questionText}>
      <div className="px-2 text-[13px] text-muted-foreground">
        This question expired — send a new message to continue.
      </div>
    </CardShell>
  );
}
