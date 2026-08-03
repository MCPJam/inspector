/**
 * Pending `ui_ask_user` questions — the agent's clarify-before-acting seam.
 *
 * `ui_ask_user` is a UI tool whose "execution" is waiting for a click: the
 * executor calls `execute()`, which parks here on a promise, and the card
 * rendered for the tool part resolves it. The stream stays paused until then,
 * exactly as it does for any other client-fulfilled call.
 *
 * WHY THE PARKED STATE LIVES OUTSIDE REACT (module scope, like
 * `agent-chat-instances.ts`): the surface rendering the card can unmount
 * mid-question — the Home takeover dies on navigation, and the side panel
 * adopts the conversation. A promise owned by a component would be lost with
 * it, stranding the paused turn forever. Module scope means the question
 * outlives whichever surface happens to be painting it.
 *
 * EVERY PATH MUST SETTLE. An unresolved entry is a hung turn, so the store
 * exposes scoped dismissal for the ways a question stops being answerable
 * (the user sends a new message, stops generation, the session is evicted).
 * A dismissal is a NORMAL answer, not an error: the tool returns "the user
 * didn't answer".
 *
 * RECORDED, BUT NEVER GENERATED FROM. A dismissal must still write a tool
 * result — a dangling `tool_use` with no result is an invalid message history
 * for both Anthropic and OpenAI, so the next request would fail. It must NOT
 * resume the turn: abandonment is not a prompt, and a user who pressed Stop
 * or changed the subject should never get an answer to the question they
 * walked away from. `shouldAutoResumeTurn` enforces that by reading the
 * recorded outcome back out (see `readAskUserAnswerFromOutput`). The model
 * sees the unanswered question as context on the user's NEXT message, which
 * is where it belongs.
 *
 * Reload is the one case with no in-memory entry to settle: the page is new,
 * the paused turn died with the old one, and the server only persists turns
 * that complete. A hydrated part with no pending entry AND no output is
 * therefore genuinely expired — but that is the ONLY state the card may call
 * expired (see `ask-user-part.tsx`).
 */
import { create } from "zustand";
import { track } from "@/lib/analytics";

/**
 * The tool name, shared by the catalog entry and the thread renderer so the
 * card can never be wired to a name the tool doesn't register under.
 */
export const ASK_USER_TOOL_NAME = "ui_ask_user";

export interface AskUserOption {
  /** Shown to the user. */
  label: string;
  /** Returned to the model. Unique within a question. */
  value: string;
}

export interface AskUserQuestion {
  toolCallId: string;
  question: string;
  options: AskUserOption[];
  /**
   * The asking session's chatSessionId. Scopes dismissal so stopping one
   * conversation can't cancel a question parked in another (a background
   * turn in a second session keeps streaming on its own instance).
   */
  scope?: string;
}

export type AskUserDismissReason =
  | "new_message"
  | "stopped"
  | "session_evicted";

export type AskUserAnswer =
  | { kind: "selected"; value: string; label: string }
  | { kind: "freeText"; text: string }
  | { kind: "dismissed"; reason: AskUserDismissReason };

interface ParkedCall {
  resolve: (answer: AskUserAnswer) => void;
  startedAt: number;
  optionCount: number;
}

/**
 * Resolvers, kept OUT of the zustand state: they're functions, they must not
 * participate in render equality, and nothing should be able to reach them
 * through a component subscription. The store below mirrors only what the
 * card needs to paint.
 */
const parked = new Map<string, ParkedCall>();

/**
 * Calls THIS page answered, kept after they settle.
 *
 * Two jobs, both about the window between `settle()` and the tool output
 * landing: it proves the call is ours when `pending` has already dropped it
 * (provenance), and it tells the card to show "sending" instead of "expired"
 * (state). Bounded and page-lifetime — one short id per question the user
 * actually answered, which is a human-scale number.
 */
const answeredHere = new Set<string>();
const ANSWERED_HERE_LIMIT = 64;

interface AskUserState {
  /** Questions awaiting an answer, keyed by toolCallId. */
  pending: Map<string, AskUserQuestion>;
}

export const useAskUserStore = create<AskUserState>(() => ({
  pending: new Map(),
}));

/**
 * Observation-only, and never text: the question, the option labels, and any
 * free-text answer are the user's own words and stay in the transcript. Only
 * the outcome shape, the option count, and timing are emitted — enough to
 * tune the ask-threshold (high `freeText` share means the options are wrong;
 * high `dismissed` means the agent is over-asking) and nothing more.
 */
function emitResolved(answer: AskUserAnswer, call: ParkedCall): void {
  try {
    track("agent_ask_user_resolved", {
      location: "mcpjam_agent",
      outcome: answer.kind,
      option_count: call.optionCount,
      time_to_answer_ms: Date.now() - call.startedAt,
      ...(answer.kind === "dismissed" ? { dismiss_reason: answer.reason } : {}),
    });
  } catch {
    // Telemetry must never break tool fulfillment — a lost result hangs the
    // stream, which is strictly worse than a lost event.
  }
}

/**
 * Resolve a parked call exactly once. Returns false when the id isn't parked
 * (already settled, or never ours), which is what makes double-click on an
 * option and a racing dismissal safe.
 */
function settle(toolCallId: string, answer: AskUserAnswer): boolean {
  const call = parked.get(toolCallId);
  if (!call) return false;
  parked.delete(toolCallId);
  useAskUserStore.setState((state) => {
    if (!state.pending.has(toolCallId)) return state;
    const pending = new Map(state.pending);
    pending.delete(toolCallId);
    return { pending };
  });
  emitResolved(answer, call);
  call.resolve(answer);
  return true;
}

/**
 * Park a question and return the promise the tool's `execute()` awaits.
 * Never rejects: the tool layer treats a rejection as a failed call, and a
 * question the user simply didn't answer isn't a failure.
 */
export function registerAskUserQuestion(
  question: AskUserQuestion,
): Promise<AskUserAnswer> {
  // A re-registered id would orphan the first promise (its awaiting
  // `execute` never returns → the turn hangs). The executor's settled/
  // in-flight guard makes this unreachable today; settling the old one keeps
  // it unreachable if that guard ever changes.
  if (parked.has(question.toolCallId)) {
    settle(question.toolCallId, {
      kind: "dismissed",
      reason: "session_evicted",
    });
  }
  return new Promise<AskUserAnswer>((resolve) => {
    parked.set(question.toolCallId, {
      resolve,
      startedAt: Date.now(),
      optionCount: question.options.length,
    });
    useAskUserStore.setState((state) => {
      const pending = new Map(state.pending);
      pending.set(question.toolCallId, question);
      return { pending };
    });
  });
}

/** Answer a pending question. No-op (false) if it already settled. */
export function answerAskUserQuestion(
  toolCallId: string,
  answer: Exclude<AskUserAnswer, { kind: "dismissed" }>,
): boolean {
  const settled = settle(toolCallId, answer);
  if (settled) {
    if (answeredHere.size >= ANSWERED_HERE_LIMIT) {
      const oldest = answeredHere.values().next().value;
      if (oldest !== undefined) answeredHere.delete(oldest);
    }
    answeredHere.add(toolCallId);
  }
  return settled;
}

/**
 * Settle every question that can no longer be answered. Pass `scope` (a
 * chatSessionId) to limit the sweep to one conversation; omit it only for
 * teardown paths that really do mean "all of them".
 *
 * Returns the settled tool-call ids, NOT a count: resolving the promise is
 * only the start: the parked `execute` returns on a later microtask and the
 * executor writes the tool output after that. A caller about to send another
 * request has to WAIT for those outputs (an unresolved tool call is an
 * invalid message history for both Anthropic and OpenAI), and it needs the
 * ids to know what to wait for.
 */
export function dismissAskUserQuestions(
  reason: AskUserDismissReason,
  opts?: { scope?: string },
): string[] {
  const dismissed: string[] = [];
  for (const [toolCallId, question] of [
    ...useAskUserStore.getState().pending,
  ]) {
    if (opts?.scope !== undefined && question.scope !== opts.scope) continue;
    if (settle(toolCallId, { kind: "dismissed", reason })) {
      dismissed.push(toolCallId);
    }
  }
  return dismissed;
}

/** The pending question for a tool part, or null once it has been answered. */
export function useAskUserPendingQuestion(
  toolCallId: string | undefined,
): AskUserQuestion | null {
  return useAskUserStore((state) =>
    toolCallId ? (state.pending.get(toolCallId) ?? null) : null,
  );
}

/**
 * Whether any question is parked for a session. The agent's instance eviction
 * needs this because a parked call does NOT look idle: `onToolCall` is awaited
 * by the SDK, so `chat.status` stays `"streaming"` for as long as the question
 * is unanswered (pinned by the ask-user SDK canary). Without this, a detached
 * session's question could never be reached by the idle sweep.
 */
export function hasPendingAskUserQuestions(scope: string): boolean {
  for (const question of useAskUserStore.getState().pending.values()) {
    if (question.scope === scope) return true;
  }
  return false;
}

/**
 * The answer recorded in a settled tool part's output, or null when the output
 * isn't one of ours / can't be read. Single source of truth for decoding the
 * `okResult`-wrapped payload: the thread card reads it to paint the outcome,
 * and the auto-resume gate reads it to recognise a dismissal.
 *
 * Defensive by construction — a shape we don't recognise returns null rather
 * than throwing inside a render or a stream predicate.
 */
export function readAskUserAnswerFromOutput(
  output: unknown,
): { kind: AskUserAnswer["kind"]; label?: string } | null {
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

/**
 * Whether THIS `ui_ask_user` call is one we asked — per call, never per page.
 *
 * The name alone can't decide it: a connected MCP server may legitimately
 * expose a tool called `ui_ask_user`, and the executor deliberately lets such
 * a tool run untouched. Nor can page-global registry state: the `ui_*`
 * catalog is registered app-wide on ordinary inspector routes, so "is the
 * tool registered" is true almost everywhere and would claim a real server
 * call in a regular chat. `shippedNames` is worse still — page-lifetime and
 * never evicted, so one agent turn would poison every later transcript.
 *
 * Provenance instead, in three forms, each of which only WE can produce:
 *   - the question is parked here (we are asking it right now),
 *   - we answered it on this page and the output is still in flight,
 *   - the recorded output decodes as one of our payloads (hydrated history).
 * Anything else is somebody else's tool call and renders as one.
 */
export function useAskUserCallIsOurs(
  toolCallId: string | undefined,
  output: unknown,
): boolean {
  const parkedHere = useAskUserStore((state) =>
    toolCallId ? state.pending.has(toolCallId) : false,
  );
  if (!toolCallId) return false;
  if (parkedHere) return true;
  if (answeredHere.has(toolCallId)) return true;
  return readAskUserAnswerFromOutput(output) !== null;
}

/** True while a locally-answered call's output has not landed yet. */
export function wasAnsweredHere(toolCallId: string | undefined): boolean {
  return toolCallId ? answeredHere.has(toolCallId) : false;
}

export function __resetAskUserStoreForTests(): void {
  // Settle rather than drop: a test that leaves a promise dangling would
  // otherwise leak an un-awaited `execute` into the next test.
  for (const toolCallId of [...parked.keys()]) {
    settle(toolCallId, { kind: "dismissed", reason: "session_evicted" });
  }
  parked.clear();
  answeredHere.clear();
  useAskUserStore.setState({ pending: new Map() });
}
