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
import { LISTEN_PROBE_TIMEOUT_MS } from "./evidence.js";
import { errorCode, errorMessage, isRecord } from "./metadata.js";

/** The only revision whose tasks use `tasks/result` to deliver input requests. */
const LEGACY_TASKS_VERSION = "2025-11-25";
const RELATED_TASK_META = "io.modelcontextprotocol/related-task";
const ANSWERS_NEED_PIN =
  "The answers in setup are only sent over tasks/result on an HTTP run pinned to 2025-11-25.";
/** The `action` values an elicitation answer can carry. */
const ANSWER_ACTIONS = new Set(["accept", "decline", "cancel"]);

/**
 * How long one call may stay open. Long enough for a server to deliver its
 * input requests or to end the task, short enough that a task nobody can
 * answer does not spend the whole poll budget. The same bound the suite gives
 * the other request a server may hold open (`subscriptions/listen`).
 */
export const INPUT_REQUIRED_RESULT_WAIT_MS = LISTEN_PROBE_TIMEOUT_MS;

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
  /** The `inputResponses` key the answer came from. Absent when none was given. */
  key?: string;
  /** The `action` sent back. `cancel` when there was no answer to give. */
  action: string;
  /** For an `accept`: whether its content fits the form the server sent. */
  fits?: boolean;
  /** A URL-mode request, which no configured answer can stand in for. */
  mode?: "url";
}

export type InputRequiredResultCall = (
  | /** The server returned a result. It only does that once the task has ended. */
    { outcome: "returned"; result: unknown }
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
 * An answer the client can send for `elicitation/create`: a known `action`,
 * and for content, the flat values an elicitation result may carry. Anything
 * else would reach the server as the client's own -32602, not as an answer.
 */
function isElicitAnswer(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (typeof value.action !== "string" || !ANSWER_ACTIONS.has(value.action)) {
    return false;
  }
  if (value.content === undefined) return true;
  return (
    isRecord(value.content) &&
    Object.values(value.content).every(
      (field) =>
        typeof field === "string" ||
        typeof field === "number" ||
        typeof field === "boolean" ||
        (Array.isArray(field) &&
          field.every((item) => typeof item === "string"))
    )
  );
}

/** The configured answers this wire can send, in key order. */
function usableAnswers(
  inputResponses: Record<string, unknown> | undefined
): [string, Record<string, unknown>][] {
  return Object.entries(inputResponses ?? {}).filter(
    (entry): entry is [string, Record<string, unknown>] =>
      isElicitAnswer(entry[1])
  );
}

/**
 * Whether `content` answers the form. Passing the schema is not enough: an
 * answer written for another question passes any form whose fields are all
 * optional, so its keys must also be the form's own.
 */
function fitsForm(requestedSchema: unknown, content: unknown): boolean {
  const fields = isRecord(content) ? content : {};
  if (checkToolArgs(requestedSchema, fields).verdict !== "valid") return false;
  const properties =
    isRecord(requestedSchema) && isRecord(requestedSchema.properties)
      ? requestedSchema.properties
      : undefined;
  return (
    properties === undefined ||
    Object.keys(fields).every((key) => Object.hasOwn(properties, key))
  );
}

/**
 * Answers the server's `elicitation/create` requests from the run's
 * `inputResponses`.
 *
 * The 2025-11-25 wire has no request keys, so an answer cannot be looked up by
 * name. Each configured answer is used once: first the `accept` whose content
 * fits the form the server sent, else the next one in key order. When none is
 * left the client says it has no answer (`cancel`); it never invents one.
 */
export class TaskInputAnswers {
  /** Every request answered so far, on any stream, in order. */
  readonly log: AnsweredInput[] = [];
  private readonly unused: [string, Record<string, unknown>][];

  constructor(inputResponses: Record<string, unknown>) {
    this.unused = usableAnswers(inputResponses);
  }

  readonly handler: ElicitationHandler = (params) => {
    const request = params as {
      mode?: unknown;
      message?: unknown;
      requestedSchema?: unknown;
      _meta?: Record<string, unknown>;
    };
    const message = String(request.message ?? "");
    // "All requests, notifications, and responses related to a task MUST
    // include the `io.modelcontextprotocol/related-task` key" (tasks.mdx:470).
    const relatedTask = request._meta?.[RELATED_TASK_META];
    const reply = (answer: Record<string, unknown>) =>
      ({
        ...answer,
        ...(relatedTask === undefined
          ? {}
          : {
              _meta: {
                ...(isRecord(answer._meta) ? answer._meta : {}),
                [RELATED_TASK_META]: relatedTask,
              },
            }),
      }) as Awaited<ReturnType<ElicitationHandler>>;

    // URL mode asks a person to act on a web page. No configured answer
    // stands in for that, so the run says it has none instead of consenting
    // on someone's behalf, and keeps its answers for the forms.
    if (request.mode === "url") {
      this.log.push({ message, action: "cancel", mode: "url" });
      return reply({ action: "cancel" });
    }

    const fitting = this.unused.findIndex(
      ([, answer]) =>
        answer.action === "accept" &&
        fitsForm(request.requestedSchema, answer.content)
    );
    const [picked] = this.unused.splice(Math.max(fitting, 0), 1);
    if (!picked) {
      this.log.push({ message, action: "cancel" });
      return reply({ action: "cancel" });
    }
    const [key, answer] = picked;
    this.log.push({
      message,
      key,
      action: String(answer.action),
      ...(answer.action === "accept"
        ? { fits: fitsForm(request.requestedSchema, answer.content) }
        : {}),
    });
    return reply(answer);
  };
}

/**
 * The answers for one run, or `undefined` when it will not answer.
 *
 * A client that answers `elicitation/create` has to say so in `initialize`,
 * so this is decided before connecting, and the capability is only declared
 * when both hold:
 *
 * - usable `inputResponses` are configured. Without them the run has nothing
 *   to say, and declaring the capability would invite questions it cannot
 *   answer.
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

/**
 * The server config for a run that answers. A client only gets the server's
 * questions if `initialize` says it can answer them, and an EXACT capability
 * set (`clientCapabilities`, which every Inspector run sends) is advertised as
 * written, so `elicitation` is added to it here.
 */
export function serverConfigForAnswers(
  serverConfig: MCPServerConfig,
  answers: TaskInputAnswers | undefined
): MCPServerConfig {
  const exact = serverConfig.clientCapabilities;
  if (!answers || !exact || exact.elicitation != null) return serverConfig;
  return { ...serverConfig, clientCapabilities: { ...exact, elicitation: {} } };
}

function hasAnswers(config: {
  inputResponses?: Record<string, unknown>;
}): boolean {
  return usableAnswers(config.inputResponses).length > 0;
}

function isPinnedToLegacyTasks(config: {
  serverConfig: MCPServerConfig;
}): boolean {
  // Only an HTTP config carries a pin. A stdio run can still land on
  // 2025-11-25, but nothing can pin it there, so it does not answer, and the
  // report says the answers need an HTTP run pinned to 2025-11-25.
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
    const result = await options.manager.getTaskResult(
      options.serverId,
      options.taskId,
      { timeout: options.timeoutMs }
    );
    return { outcome: "returned", result, ...done() };
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
   * Every input request this run answered, on whatever stream it came: a
   * server may also ask on the GET stream (tasks.mdx:439), outside any call.
   */
  private get answered(): AnsweredInput[] {
    return this.answers?.log ?? [];
  }

  /**
   * Make the call and say whether polling goes on.
   *
   * It goes on when the server answered the call (the task has ended, or it
   * will not move) or when an input request was answered during it (the task
   * has what it asked for). Either way the task in hand is stale, so the
   * answer is `"reread"`: read it again now, not after a poll interval. A call
   * that brought neither is made once: the task is parked, and asking again
   * would not change that.
   */
  async run(
    manager: Pick<MCPClientManager, "getTaskResult">,
    serverId: string,
    taskId: string,
    remainingMs: number
  ): Promise<false | "reread"> {
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
    return call.outcome !== "no-answer" || call.answered.length > 0
      ? "reread"
      : false;
  }

  /**
   * The result the last call returned, when it returned one. The server only
   * answers `tasks/result` with a result once the task has ended, so that is
   * the task's final result, already in hand: no need to ask for it again.
   */
  returnedResult(): { result: unknown } | undefined {
    const last = this.calls.at(-1);
    return last?.outcome === "returned" ? { result: last.result } : undefined;
  }

  /**
   * The JSON-RPC error the last call got, when it got one. It is the task's
   * final result only if the task then reads as ended without completing;
   * while the task is still open it is an early refusal.
   */
  returnedError(): { code: number; message: string } | undefined {
    const last = this.calls.at(-1);
    return last?.outcome === "error"
      ? { code: last.code, message: last.message }
      : undefined;
  }

  /** `details` for a check, or `undefined` when nothing was asked or called. */
  details(): Record<string, unknown> | undefined {
    const last = this.calls.at(-1);
    const answered = this.answered;
    if (!last && answered.length === 0) return undefined;
    return {
      resultWhileInputRequired: {
        ...(last ? describeResultCall({ ...last, answered }) : { answered }),
        ...(this.calls.length > 1 ? { calls: this.calls.length } : {}),
        ...(this.answersNotSent ? { answersNotSent: ANSWERS_NEED_PIN } : {}),
      },
    };
  }

  /**
   * Whether this run left a question without a usable answer: it had none to
   * give, ran out, was asked for something no answer can stand in for (URL
   * mode), or sent an answer that does not fit the form.
   *
   * When it did, a task that then ends without completing ended on this run,
   * not on the server. When every question got an answer that fits, the task
   * is graded like any other finished task.
   */
  couldNotAnswer(): boolean {
    const answered = this.answered;
    return (
      answered.length === 0 ||
      answered.some((entry) => entry.key === undefined || entry.fits === false)
    );
  }

  /**
   * Why a task that asked for input, did not get a usable answer, and then
   * ended without completing is not a result to grade. `setup` is true when
   * the answers in setup are what to fix.
   */
  unfinishedReason(status: string): { message: string; setup: boolean } {
    const answered = this.answered;
    if (answered.some((entry) => entry.mode === "url")) {
      return {
        message: `The task asked for input on a web page (URL mode), which this run cannot give, and ended as ${status}, so there was no result to check.`,
        setup: false,
      };
    }
    if (answered.some((entry) => entry.key === undefined)) {
      return {
        message: `The task asked for more input than the answers in setup cover, and ended as ${status}. Add an answer for each question, then run again.`,
        setup: true,
      };
    }
    const misfit = answered.find((entry) => entry.fits === false);
    if (misfit) {
      return {
        message: `One of the answers in setup (${JSON.stringify(
          misfit.key
        )}) doesn't fit what the task asked (${JSON.stringify(
          misfit.message
        )}), and the task ended as ${status}. Fix that answer in setup, then run again.`,
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
