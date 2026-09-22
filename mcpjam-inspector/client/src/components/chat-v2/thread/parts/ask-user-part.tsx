/**
 * Renders a `ui_ask_user` tool part as an inline clarifying-question card.
 *
 * INLINE, not a modal, for the same reason the agent's `Chat` instance lives
 * outside React: the surface painting this card can be replaced mid-question
 * (Home takeover → side panel on a navigation handoff). A modal owned by a
 * route would take the question with it; a card that reads a module-scoped
 * store simply re-renders wherever the conversation lands.
 *
 * States, and the source of truth for each. "Expired" is the dangerous one:
 * it is the fall-through, so anything not positively identified would inherit
 * copy that is actively wrong. Every other state is therefore recognised
 * explicitly, and expiry is reserved for the single case that earns it.
 *
 *   pending   — a parked question, on an interactive surface. Clickable.
 *   read-only — a parked question on a NON-interactive surface (eval replay,
 *               a shared transcript). The question is live, just not this
 *               viewer's to answer; showing it as expired would be a lie.
 *   resolving — answered locally, output not back yet. The store clears the
 *               entry the instant the promise settles, which is one or more
 *               renders BEFORE `addToolOutput` lands — without a latch the
 *               card flashes "expired" between the click and the result.
 *   answered  — the part carries an output; read the outcome back from it so
 *               a reloaded transcript shows what was chosen.
 *   expired   — no parked question, no output, nothing answered here. Only
 *               reachable after a reload: the paused turn died with the
 *               previous page and the server never persisted it.
 */
import { useCallback, useMemo, useState } from "react";
import { Check, HelpCircle } from "lucide-react";

import { cn } from "@/lib/chat-utils";
import {
  answerAskUserQuestion,
  readAskUserAnswerFromOutput,
  useAskUserPendingQuestion,
  wasAnsweredHere,
  type AskUserAnswer,
  type AskUserOption,
} from "@/lib/webmcp/ask-user-store";

/**
 * The answer as recorded in the transcript. Decoded by the store so the
 * auto-resume gate and this card can never disagree about what a settled
 * payload means. A shape we don't recognise degrades to the neutral
 * "Answered" row rather than throwing inside a thread render.
 */
type RecordedAnswer = { kind: AskUserAnswer["kind"]; label?: string };

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
  onAnswered,
}: {
  toolCallId: string;
  question: string;
  options: AskUserOption[];
  /**
   * Fired when THIS card resolved the question. The parent latches it: the
   * store drops the pending entry on settle, which can re-render us before
   * `addToolOutput` lands, and without the latch that gap paints "expired".
   */
  onAnswered: () => void;
}) {
  const [freeText, setFreeText] = useState("");
  const [showFreeText, setShowFreeText] = useState(false);

  const choose = useCallback(
    (option: AskUserOption) => {
      // The store's settle() is one-shot, so a double-click resolves once —
      // no local "submitting" flag needed to keep the turn honest. Latch only
      // on the call that actually won, so a losing double-click can't claim a
      // resolution that wasn't its own.
      const settled = answerAskUserQuestion(toolCallId, {
        kind: "selected",
        value: option.value,
        label: option.label,
      });
      if (settled) onAnswered();
    },
    [onAnswered, toolCallId],
  );

  const submitFreeText = useCallback(() => {
    const trimmed = freeText.trim();
    if (!trimmed) return;
    const settled = answerAskUserQuestion(toolCallId, {
      kind: "freeText",
      text: trimmed,
    });
    if (settled) onAnswered();
  }, [freeText, onAnswered, toolCallId]);

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
    // NOT "continued on its best interpretation" — the turn is suppressed on
    // a dismissal, so the assistant does not answer the abandoned request.
    return "No answer — the assistant stopped here";
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

/**
 * A parked question the viewer may not answer (eval replay, a shared
 * transcript). Shows the real choices, greyed and inert — the question is
 * live, so calling it expired would be false, and hiding the options would
 * lose the context of what was actually asked.
 */
function ReadOnlyParkedCard({
  question,
  options,
}: {
  question: string;
  options: AskUserOption[];
}) {
  return (
    <CardShell question={question}>
      <div className="flex flex-col gap-1" data-testid="ask-user-readonly">
        {options.map((option, index) => (
          <div
            key={option.value}
            className="flex items-center gap-2.5 px-2 py-1.5 text-[13px] text-muted-foreground"
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-foreground/10 text-[11px] tabular-nums text-muted-foreground">
              {index + 1}
            </span>
            {option.label}
          </div>
        ))}
        <div className="px-2 pt-1 text-[12px] text-muted-foreground/70">
          Waiting for an answer.
        </div>
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
  // Bridges the window between settle() dropping the pending entry and
  // `addToolOutput` producing the part's output. Read from the STORE rather
  // than local state because part-switch keys ownership off the same set —
  // a local latch could say "resolving" while the parent said "not ours".
  // `answeredTick` only forces the re-render; the store holds the truth.
  const [answeredTick, setAnsweredTick] = useState(0);
  const handleAnswered = useCallback(() => setAnsweredTick((n) => n + 1), []);
  void answeredTick;
  const answeredLocally = wasAnsweredHere(toolCallId);

  // Terminal output wins over every local guess — it is the transcript.
  if (hasOutput) {
    return (
      <SettledCard
        question={questionText}
        answer={readAskUserAnswerFromOutput(output)}
      />
    );
  }

  if (pending && toolCallId) {
    return interactive ? (
      <PendingCard
        toolCallId={toolCallId}
        question={pending.question}
        options={pending.options}
        onAnswered={handleAnswered}
      />
    ) : (
      <ReadOnlyParkedCard
        question={pending.question}
        options={pending.options}
      />
    );
  }

  // Answered here, output still in flight: the store has already forgotten the
  // question but the result has not landed. Not expired — resolving.
  if (answeredLocally) {
    return (
      <CardShell question={questionText}>
        <div
          className="px-2 text-[13px] text-muted-foreground"
          data-testid="ask-user-resolving"
        >
          Sending your answer…
        </div>
      </CardShell>
    );
  }

  // Nothing parked, nothing answered here, no output: this transcript was
  // hydrated after a reload that killed the paused turn. Say so rather than
  // render dead buttons.
  return (
    <CardShell question={questionText}>
      <div className="px-2 text-[13px] text-muted-foreground">
        This question expired — send a new message to continue.
      </div>
    </CardShell>
  );
}
