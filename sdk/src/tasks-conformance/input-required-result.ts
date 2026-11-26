/**
 * What a 2025-11-25 client does when a task parks on `input_required`.
 *
 * "When the requestor encounters the `input_required` status, it SHOULD
 * preemptively call `tasks/result`" (2025-11-25 tasks.mdx:449). On that wire
 * the call is how the client receives the server's input requests: the server
 * holds the response open, sends `elicitation/create` on its stream, and
 * answers once the task has ended.
 *
 * Two halves, both here:
 *
 * - the call, sent once and bounded by what is left of the poll budget;
 * - the answers, taken from the run's `inputResponses`, so the question the
 *   server sends over that call gets the configured answer and not
 *   "Method not found".
 *
 * The extension wire has no `tasks/result`: its input requests ride on
 * `tasks/get` and are answered with `tasks/update`.
 */

import type { MCPClientManager } from "../mcp-client-manager/MCPClientManager.js";
import type { MCPServerConfig } from "../mcp-client-manager/index.js";
import type { ElicitationHandler } from "../mcp-client-manager/types.js";
import { checkToolArgs } from "../conformance-tool-args.js";
import { errorCode, errorMessage, isRecord } from "./metadata.js";

/** The only revision whose tasks use `tasks/result` to deliver input requests. */
const LEGACY_TASKS_VERSION = "2025-11-25";
const RELATED_TASK_META = "io.modelcontextprotocol/related-task";
const ANSWERS_NEED_PIN =
  "The answers in setup are only sent over tasks/result on a run pinned to 2025-11-25.";

/**
 * How long one call may stay open. Long enough for a server to deliver its
 * input requests or to end the task, short enough that a task nobody can
 * answer does not spend the whole poll budget. The same bound the suite gives
 * the other request a server may hold open (`subscriptions/listen`).
 */
export const INPUT_REQUIRED_RESULT_WAIT_MS = 5_000;

/**
 * The bound for one call: never more than what is left of the poll budget.
 * The polls, this wait and the reads after it share that one budget.
 */
export function inputRequiredResultWaitMs(remainingMs: number): number {
  return Math.max(0, Math.min(INPUT_REQUIRED_RESULT_WAIT_MS, remainingMs));
}

/** One input request the server sent, and what this run said to it. */
export interface AnsweredInput {
  /** The server's question. */
  message: string;
  /** The `inputResponses` key the answer came from. Absent when none was left. */
  key?: string;
  /** The `action` sent back. `cancel` when there was no answer to give. */
  action: string;
}

export type InputRequiredResultCall = (
  | /** The server returned a result. It only does that once the task has ended. */
  { outcome: "returned" }
  /** The server answered with a JSON-RPC error: the task failed, or it refused. */
  | { outcome: "error"; code: number; message: string }
  /** Nothing came back in time. */
  | { outcome: "no-answer"; message: string }
) & {
  waitedMs: number;
  /** Input requests answered while the call was open. */
  answered: AnsweredInput[];
};

/**
 * Answers the server's `elicitation/create` requests from the run's
 * `inputResponses`.
 *
 * The 2025-11-25 wire has no request keys, so an answer cannot be looked up by
 * name. Each configured answer is used once: first the one whose content fits
 * the form the server sent, else the next one in the order written. When none
 * is left the client says it has no answer (`cancel`); it never invents one.
 */
export class TaskInputAnswers {
  /** Every request answered so far, in order. */
  readonly log: AnsweredInput[] = [];
  private readonly unused: [string, Record<string, unknown>][];

  constructor(inputResponses: Record<string, unknown>) {
    this.unused = Object.entries(inputResponses).filter(
      (entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])
    );
  }

  readonly handler: ElicitationHandler = (params) => {
    const request = params as {
      message?: unknown;
      requestedSchema?: unknown;
      _meta?: Record<string, unknown>;
    };
    const fits = this.unused.findIndex(
      ([, answer]) =>
        answer.action === "accept" &&
        checkToolArgs(request.requestedSchema, answer.content ?? {}).verdict ===
          "valid"
    );
    const [picked] = this.unused.splice(Math.max(fits, 0), 1);
    const [key, answer] = picked ?? [undefined, { action: "cancel" }];
    this.log.push({
      message: String(request.message ?? ""),
      ...(key === undefined ? {} : { key }),
      action: String(answer.action),
    });
    // "All requests, notifications, and responses related to a task MUST
    // include the `io.modelcontextprotocol/related-task` key" (tasks.mdx:470).
    const relatedTask = request._meta?.[RELATED_TASK_META];
    return {
      ...answer,
      ...(relatedTask === undefined
        ? {}
        : { _meta: { [RELATED_TASK_META]: relatedTask } }),
    } as Awaited<ReturnType<ElicitationHandler>>;
  };
}

/**
 * The answers for one run, or `undefined` when it will not answer.
 *
 * A client that answers `elicitation/create` has to say so in `initialize`,
 * so this is decided before connecting, and the capability is only declared
 * when both hold:
 *
 * - `inputResponses` are configured. Without them the run has nothing to say,
 *   and declaring the capability would invite questions it cannot answer.
 * - The run is pinned to 2025-11-25. On the extension wire the same answers go
 *   out with `tasks/update`, and what that wire declares is left as it is.
 */
export function taskInputAnswersFor(config: {
  serverConfig: MCPServerConfig;
  inputResponses?: Record<string, unknown>;
}): TaskInputAnswers | undefined {
  if (!hasAnswers(config) || !isPinnedToLegacyTasks(config)) return undefined;
  return new TaskInputAnswers(config.inputResponses ?? {});
}

/** True when answers are configured but the run is not pinned to 2025-11-25. */
export function answersNeedPin(config: {
  serverConfig: MCPServerConfig;
  inputResponses?: Record<string, unknown>;
}): boolean {
  return hasAnswers(config) && !isPinnedToLegacyTasks(config);
}

function hasAnswers(config: {
  inputResponses?: Record<string, unknown>;
}): boolean {
  return Object.keys(config.inputResponses ?? {}).length > 0;
}

function isPinnedToLegacyTasks(config: {
  serverConfig: MCPServerConfig;
}): boolean {
  // Only HTTP configs carry a pin; a stdio server has no tasks wire to pin.
  const pinned = (config.serverConfig as { mcpProtocolVersion?: unknown })
    .mcpProtocolVersion;
  return pinned === LEGACY_TASKS_VERSION;
}

/**
 * Send one `tasks/result` for a task parked on `input_required`.
 *
 * `manager.getTaskResult` sends exactly one request here: the suite's manager
 * has no retry policy.
 */
export async function callResultWhileInputRequired(options: {
  manager: Pick<MCPClientManager, "getTaskResult">;
  serverId: string;
  taskId: string;
  timeoutMs: number;
  answers?: TaskInputAnswers;
}): Promise<InputRequiredResultCall> {
  const startedAt = Date.now();
  const answeredBefore = options.answers?.log.length ?? 0;
  const done = () => ({
    waitedMs: Date.now() - startedAt,
    answered: options.answers?.log.slice(answeredBefore) ?? [],
  });
  try {
    await options.manager.getTaskResult(options.serverId, options.taskId, {
      timeout: options.timeoutMs,
    });
    return { outcome: "returned", ...done() };
  } catch (error) {
    // The client's own timeout carries a string code (`REQUEST_TIMEOUT`), and
    // a dropped connection carries none. A number is a JSON-RPC error code,
    // so the server answered, whatever the number: -32001 included.
    const code = errorCode(error);
    return code === undefined
      ? { outcome: "no-answer", message: errorMessage(error), ...done() }
      : { outcome: "error", code, message: errorMessage(error), ...done() };
  }
}

/** `details` for a check that reports on a task this call was made for. */
export function describeResultCall(
  call: InputRequiredResultCall
): Record<string, unknown> {
  return {
    outcome: call.outcome,
    waitedMs: call.waitedMs,
    ...(call.outcome === "error" ? { code: call.code } : {}),
    ...(call.outcome === "returned" ? {} : { message: call.message }),
    ...(call.answered.length > 0 ? { answered: call.answered } : {}),
  };
}

/**
 * What a task did after it asked for input on the 2025-11-25 wire, across
 * every `tasks/result` the run made for it.
 */
export class InputRequiredResultLeg {
  /** The calls made, in order. */
  readonly calls: InputRequiredResultCall[] = [];

  constructor(
    readonly answers?: TaskInputAnswers,
    /** Answers are configured, but this run is not one that sends them. */
    private readonly answersNotSent = false
  ) {}

  /**
   * Make the call and say whether polling goes on.
   *
   * It goes on when the server answered the call (the task has ended, so the
   * state in hand is stale) or when an input request was answered during it
   * (the task has what it asked for). A call that brought neither is made
   * once: the task is parked, and asking again would not change that.
   */
  async run(
    manager: Pick<MCPClientManager, "getTaskResult">,
    serverId: string,
    taskId: string,
    remainingMs: number
  ): Promise<boolean> {
    const previous = this.calls.at(-1);
    if (previous && previous.answered.length === 0) return false;
    // The budget is spent: a call with no time to wait would only be noise.
    if (remainingMs <= 0) return false;
    const call = await callResultWhileInputRequired({
      manager,
      serverId,
      taskId,
      timeoutMs: inputRequiredResultWaitMs(remainingMs),
      answers: this.answers,
    });
    this.calls.push(call);
    return call.outcome !== "no-answer" || call.answered.length > 0;
  }

  /** `details` for a check, or `undefined` when no call was made. */
  details(): Record<string, unknown> | undefined {
    const last = this.calls.at(-1);
    if (!last) return undefined;
    const answered = this.calls.flatMap((call) => call.answered);
    return {
      resultWhileInputRequired: {
        ...describeResultCall({ ...last, answered }),
        ...(this.calls.length > 1 ? { calls: this.calls.length } : {}),
        ...(this.answersNotSent ? { answersNotSent: ANSWERS_NEED_PIN } : {}),
      },
    };
  }

  /**
   * Why a task that asked for input and then ended without completing is not
   * a result to grade.
   *
   * The task was waiting on this run. If the run answered, the answers are the
   * caller's setup; if it did not, the task ended for want of an answer. Either
   * way the server was not shown to break a rule.
   */
  unfinishedReason(status: string): { message: string; setup: boolean } {
    const answered = this.calls.flatMap((call) => call.answered);
    if (answered.some((entry) => entry.key === undefined)) {
      return {
        message: `The task asked for more input than the answers in setup cover, and ended as ${status}. Add an answer for each question, then run again.`,
        setup: true,
      };
    }
    if (answered.length > 0) {
      return {
        message: `The task asked for input, got the answers from setup, and ended as ${status}. Check the answers in setup, then run again.`,
        setup: true,
      };
    }
    return {
      message: `The task asked for input, this run had no answer to give, and it ended as ${status}, so there was no result to check.${
        this.answersNotSent ? ` ${ANSWERS_NEED_PIN}` : ""
      }`,
      setup: false,
    };
  }
}
