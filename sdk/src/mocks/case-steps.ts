import {
  inputRequired,
  ProtocolError,
  ProtocolErrorCode,
} from "@modelcontextprotocol/server";
import type {
  CallToolResult,
  InputRequest,
  InputRequiredResult,
} from "@modelcontextprotocol/server";
import { isInputStep } from "./definition-types.js";
import type {
  MockListKind,
  MockSavedCase,
  MockStep,
} from "./definition-types.js";
import { fillInputs } from "./saved-answers.js";

type Obj = Record<string, unknown>;
type InputStep = Extract<MockStep, { kind: "ask" | "askUrl" | "sample" }>;

const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What a case run needs from the call it runs in. */
export interface StepHost {
  /** Sends `notifications/progress`; absent when the caller sent no progress token. */
  progress?(p: {
    progress: number;
    total?: number;
    message?: string;
  }): Promise<void>;
  log(level: string, data: unknown, logger?: string): Promise<void>;
  /** Tells the client a list changed. */
  listChanged(list: MockListKind): Promise<void>;
  /** Tells subscribers a resource changed. */
  resourceUpdated(uri: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  /**
   * Waits for the client's replies to a batch of questions (a task does).
   * Without it the run stops at the questions and says what to ask.
   */
  ask?(requests: Record<string, InputRequest>): Promise<Obj>;
  /** Reports each step that ran, for the trace and tests. */
  onStep?(step: MockStep): void;
}

/** Where a stopped run picks up: the first step after the questions, and the replies so far. */
export interface CaseResume {
  at: number;
  /** The ids the client was asked. */
  pending: string[];
  replies: Obj;
}

export type CaseRun =
  | { kind: "result"; result: CallToolResult }
  | { kind: "ask"; requests: Record<string, InputRequest>; resume: CaseResume };

/** The embedded request a question step sends, with `{{input.x}}` filled. */
function requestOf(step: InputStep, input: Obj): InputRequest {
  const fill = (text: string) => fillInputs(text, input);
  if (step.kind === "ask") {
    return inputRequired.elicit({
      message: fill(step.message),
      requestedSchema: step.requestedSchema as never,
    });
  }
  if (step.kind === "askUrl") {
    return inputRequired.elicitUrl({
      message: fill(step.message),
      url: fill(step.url),
    });
  }
  return inputRequired.createMessage({
    messages: [
      { role: "user", content: { type: "text", text: fill(step.prompt) } },
    ],
    ...(step.systemPrompt !== undefined && {
      systemPrompt: fill(step.systemPrompt),
    }),
    maxTokens: step.maxTokens,
  });
}

/**
 * What the result reads about a reply: a question's `action` and `content`,
 * a model request's `text`, `model` and `stopReason`.
 */
export function replyOf(step: InputStep, response: unknown): Obj {
  const reply = isObj(response) ? response : {};
  if (step.kind !== "sample") {
    return {
      action: typeof reply.action === "string" ? reply.action : "cancel",
      content: isObj(reply.content) ? reply.content : {},
    };
  }
  const blocks = Array.isArray(reply.content) ? reply.content : [reply.content];
  const text = blocks
    .filter(
      (b): b is { type: "text"; text: string } =>
        isObj(b) && b.type === "text" && typeof b.text === "string"
    )
    .map((b) => b.text)
    .join("");
  return {
    text,
    ...(typeof reply.model === "string" && { model: reply.model }),
    ...(typeof reply.stopReason === "string" && {
      stopReason: reply.stopReason,
    }),
  };
}

/**
 * Runs a chosen case from `resume` (or the start): notification steps are
 * sent, then the questions are asked, then `finish` makes the result from the
 * replies. A run that meets questions with no `host.ask` stops and returns
 * them with where to pick up, so a 2026-07-28 caller answers in its next
 * round. A 2025-era connection keeps no session here, so it cannot be asked
 * (the caller refuses such a case before it runs).
 */
export async function runCase(
  chosen: MockSavedCase,
  input: Obj,
  host: StepHost,
  finish: (replies: Obj) => CallToolResult,
  resume?: CaseResume & { responses: Obj }
): Promise<CaseRun> {
  const steps = chosen.steps ?? [];
  const replies: Obj = { ...resume?.replies };
  let at = resume?.at ?? 0;
  // Answers to the questions the last round asked.
  for (const id of resume?.pending ?? []) {
    const step = steps.find(
      (s): s is InputStep => isInputStep(s) && s.id === id
    );
    if (step) replies[id] = replyOf(step, resume?.responses[id]);
  }
  while (at < steps.length) {
    const step = steps[at]!;
    if (step.delayMs) await host.sleep(step.delayMs);
    if (isInputStep(step)) {
      // Consecutive questions go out together.
      const batch: InputStep[] = [];
      let end = at;
      while (end < steps.length && isInputStep(steps[end]!)) {
        batch.push(steps[end] as InputStep);
        end += 1;
      }
      const requests = Object.fromEntries(
        batch.map((s) => [s.id, requestOf(s, input)])
      );
      if (!host.ask) {
        return {
          kind: "ask",
          requests,
          resume: { at: end, pending: batch.map((s) => s.id), replies },
        };
      }
      const responses = await host.ask(requests);
      for (const s of batch) {
        replies[s.id] = replyOf(s, responses[s.id]);
        host.onStep?.(s);
      }
      at = end;
      continue;
    }
    if (step.kind === "progress") {
      await host.progress?.({
        progress: step.progress,
        ...(step.total !== undefined && { total: step.total }),
        ...(step.message !== undefined && {
          message: fillInputs(step.message, input),
        }),
      });
    } else if (step.kind === "log") {
      await host.log(step.level, fillInputs(step.data, input), step.logger);
    } else if (step.kind === "listChanged") {
      await host.listChanged(step.list);
    } else {
      await host.resourceUpdated(fillInputs(step.uri, input));
    }
    host.onStep?.(step);
    at += 1;
  }
  return { kind: "result", result: finish(replies) };
}

/** The result of a stopped run: what the client must answer, and the state to send back. */
export function inputRequiredFor(
  run: Extract<CaseRun, { kind: "ask" }>
): InputRequiredResult {
  return inputRequired({
    inputRequests: run.requests,
    requestState: encodeState(run.resume),
  });
}

const MAX_STATE_CHARS = 48_000;

function encodeState(resume: CaseResume): string {
  const text = Buffer.from(JSON.stringify(resume), "utf8").toString(
    "base64url"
  );
  if (text.length > MAX_STATE_CHARS) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      "The replies so far are too large to carry to the next step. Ask for less, or ask in a form with fewer fields."
    );
  }
  return text;
}

/**
 * The state a retried request carries, or `undefined` when it is missing or
 * does not fit this case (the run then starts over). It comes from the client,
 * so it is only ever read as positions and replies for this case's own steps:
 * the worst a forged one does is change what the caller's own result says.
 */
export function readState(
  raw: unknown,
  chosen: MockSavedCase
): CaseResume | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const value: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8")
    );
    if (
      !isObj(value) ||
      !Number.isInteger(value.at) ||
      !Array.isArray(value.pending) ||
      !isObj(value.replies)
    )
      return undefined;
    const steps = chosen.steps ?? [];
    const ids = new Set(steps.filter(isInputStep).map((s) => s.id));
    const at = value.at as number;
    const pending = value.pending as unknown[];
    if (
      at < 1 ||
      at > steps.length ||
      !pending.every(
        (id): id is string => typeof id === "string" && ids.has(id)
      )
    )
      return undefined;
    return { at, pending, replies: value.replies };
  } catch {
    // Not our state, or damaged in transit: start the case again.
    return undefined;
  }
}
