import { AsyncLocalStorage } from "node:async_hooks";
import type { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { MCPClientManager } from "@mcpjam/sdk";
import {
  inputAnswerResult,
  matchInputAnswer,
  type InputAnswer,
} from "@mcpjam/sdk/contract";
import type {
  SamplingCallback,
  ElicitationCallback,
  ElicitationCallbackRequest,
  ElicitationHandler,
  MrtrInputCollector,
  TaskInputHandlers,
} from "@mcpjam/sdk";
import type { InputExchange } from "../../../shared/eval-input-exchange.js";
import {
  createConvexEvidenceTransport,
  type HarnessEvidenceTransport,
} from "../../utils/harness/harness-evidence-client.js";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";

/**
 * What an eval answers when a server asks a question: one pure resolver over a
 * case's `inputAnswers`, registered as the elicitation callback (revisions
 * before 2026-07-28), as the multi-round-trip collector (2026-07-28) and as
 * the task input handler, so the three agree. A question no reply fits is
 * declined and the exchange says no reply was set.
 */

/**
 * Asks the iteration's own model, as the person who runs the eval, and says
 * which model answered. It is the run's model, never one the server chose.
 */
export type ModelRequestAnswerer = (request: {
  system?: string;
  prompt: string;
  signal?: AbortSignal;
}) => Promise<{ text: string; model: string }>;

/** The tool call a question belongs to, and where to record the exchange. */
export interface ToolCallScope {
  tool: string;
  serverId?: string;
  record?: (exchange: InputExchange) => void;
  /** The model the iteration runs on, when the runner could build an answerer for it. */
  answerModel?: ModelRequestAnswerer;
}

const toolCallScope = new AsyncLocalStorage<ToolCallScope>();
interface IterationScope {
  exchanges: InputExchange[];
  /** The case this iteration runs, when the runner knows it. */
  caseId?: string;
}
const iterationScope = new AsyncLocalStorage<IterationScope>();

/**
 * Runs one iteration so every exchange asked during it is collected, for the
 * checks that read them. Connections are per run and carry no iteration, so
 * the iteration's own async chain is what tells them apart.
 */
export function runWithIterationExchanges<T>(run: () => T, caseId?: string): T {
  return iterationScope.run({ exchanges: [], caseId }, run);
}

/** The exchanges of the iteration this code is running in; empty outside one. */
export function currentIterationExchanges(): readonly InputExchange[] {
  return iterationScope.getStore()?.exchanges ?? [];
}

/**
 * Runs a tool call so a question asked during it knows which tool asked. The
 * connection calls back from inside the call's own async chain, on both
 * revisions, so the scope follows without the callback carrying an identity.
 */
export function withToolCallScope<T>(scope: ToolCallScope, run: () => T): T {
  return toolCallScope.run(scope, run);
}

export interface InputAnswerResolver {
  /** The replies, in the order the case lists them. */
  readonly answers: readonly InputAnswer[];
  /** Every exchange so far, in order. */
  readonly exchanges: readonly InputExchange[];
  /** Revisions before 2026-07-28: the callback the connection registers. */
  readonly elicitationCallback: ElicitationCallback;
  /** 2026-07-28: the collector for one server's `input_required` results. */
  collectorFor(serverId: string): MrtrInputCollector;
  /** Revisions before 2026-07-28: answers a server's request for the run's model. */
  readonly samplingCallback: SamplingCallback;
  /** Tasks: the same answers, for the task driver's input slot. */
  readonly taskHandlers: TaskInputHandlers;
  /** A server's elicitation handler, for a connection that declares elicitation for it alone. */
  elicitationHandlerFor(serverId: string): ElicitationHandler;
  /** Whether a connection to this server declares elicitation: it is a mock, or a reply names it. */
  declaresElicitation(server: { name: string; mock: boolean }): boolean;
  /** Whether a connection to this server declares sampling: it is a mock and the run has an answerer. */
  declaresSampling(server: { mock: boolean }): boolean;
  /** Names the connection's servers once they are authorized, so a reply can fit on `server`. */
  useServerNames(names: Record<string, string>): void;
}

export interface InputAnswerResolverOptions {
  /** Every reply of the run, in case order: used only where the case cannot be known. */
  answers: readonly InputAnswer[];
  /**
   * The replies of each case by its id. With it, a question is answered from
   * the case the iteration runs; without it (the harness proxy reads one
   * iteration's replies) `answers` are that case's own.
   */
  answersByCase?: Record<string, readonly InputAnswer[]>;
  /** The run can answer a server's request for the model. */
  modelAnswers?: boolean;
  /** The server's name as the suite names it, from the connection's server id. */
  serverName?: (serverId: string) => string | undefined;
}

type Reply = ReturnType<typeof inputAnswerResult>;

export function createInputAnswerResolver(
  options: InputAnswerResolverOptions,
): InputAnswerResolver {
  const exchanges: InputExchange[] = [];
  let names: Record<string, string> = {};

  /**
   * The replies of the case this iteration runs. Where the case cannot be
   * known (no case id in the iteration's context), the run's pooled replies
   * answer and the exchange says so.
   */
  function repliesOfRunningCase(): {
    replies: readonly InputAnswer[];
    pooled: boolean;
  } {
    if (!options.answersByCase)
      return { replies: options.answers, pooled: false };
    const caseId = iterationScope.getStore()?.caseId;
    if (caseId !== undefined) {
      return { replies: options.answersByCase[caseId] ?? [], pooled: false };
    }
    return { replies: options.answers, pooled: options.answers.length > 0 };
  }

  function answer(question: {
    serverId?: string;
    message: string;
    mode?: "form" | "url";
    tool?: string;
  }): Reply {
    const scope = toolCallScope.getStore();
    const server =
      question.serverId !== undefined
        ? (names[question.serverId] ??
          options.serverName?.(question.serverId) ??
          question.serverId)
        : undefined;
    const tool = question.tool ?? scope?.tool;
    const { replies, pooled } = repliesOfRunningCase();
    const matched = matchInputAnswer(replies, {
      ...(server !== undefined && { server }),
      ...(tool !== undefined && { tool }),
      message: question.message,
    });
    const reply = inputAnswerResult(matched?.answer);
    const exchange: InputExchange = {
      kind: "question",
      ...(server !== undefined && { server }),
      ...(tool !== undefined && { tool }),
      message: question.message,
      mode: question.mode ?? "form",
      action: reply.action,
      ...(reply.content !== undefined && { content: reply.content }),
      ...(matched && { replyIndex: matched.index }),
      ...(pooled && { pooled: true }),
      ...(!matched && {
        note: "declined, no reply was set for this question",
      }),
    };
    exchanges.push(exchange);
    iterationScope.getStore()?.exchanges.push(exchange);
    scope?.record?.(exchange);
    return reply;
  }

  /**
   * A server's request for the model, answered by the iteration's model when
   * the call it came in is running under one. Recorded as an exchange, so the
   * trace shows the request and the answer under the tool call.
   */
  async function answerModelRequest(
    serverId: string | undefined,
    params: Record<string, unknown>,
    tool?: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const scope = toolCallScope.getStore();
    if (!scope?.answerModel) {
      throw new Error(
        "A server asked for the run's model, and this run has none to give it. Run the case with a model selected.",
      );
    }
    const { system, prompt } = modelRequestWords(params);
    const { text, model } = await scope.answerModel({ system, prompt, signal });
    const server =
      serverId !== undefined ? (names[serverId] ?? serverId) : undefined;
    const asking = tool ?? scope.tool;
    const exchange: InputExchange = {
      kind: "model_request",
      ...(server !== undefined && { server }),
      ...(asking !== undefined && { tool: asking }),
      message: prompt,
      action: "answered",
      content: { text, model },
    };
    exchanges.push(exchange);
    iterationScope.getStore()?.exchanges.push(exchange);
    scope.record?.(exchange);
    return {
      role: "assistant",
      content: { type: "text", text },
      model,
      stopReason: "endTurn",
    };
  }

  const elicitationCallback: ElicitationCallback = (
    request: ElicitationCallbackRequest,
  ) =>
    answer({
      serverId: request.serverId,
      message: request.message,
      mode: request.mode ?? "form",
    });

  return {
    answers: options.answers,
    exchanges,
    elicitationCallback,
    samplingCallback: ({ serverId, params, signal }) =>
      answerModelRequest(serverId, params, undefined, signal) as never,
    collectorFor:
      (serverId) =>
      async ({ state, inputRequests, signal }) => {
        const tool =
          state.method === "tools/call" &&
          typeof state.originalParams.name === "string"
            ? state.originalParams.name
            : undefined;
        const responses: Record<string, Reply> = {};
        for (const [key, request] of Object.entries(inputRequests)) {
          const params = (request.params ?? {}) as Record<string, unknown>;
          if (request.method === "sampling/createMessage") {
            responses[key] = (await answerModelRequest(
              serverId,
              params,
              tool,
              signal,
            )) as never;
            continue;
          }
          responses[key] = answer({
            serverId,
            message: typeof params.message === "string" ? params.message : "",
            mode: params.mode === "url" ? "url" : "form",
            tool,
          });
        }
        return responses;
      },
    elicitationHandlerFor: (serverId) => (params) =>
      answer({
        serverId,
        message: params.message ?? "",
        mode: (params as { mode?: string }).mode === "url" ? "url" : "form",
      }),
    declaresElicitation: ({ name, mock }) =>
      mock ||
      options.answers.some((reply) => reply.server === name) ||
      Object.values(options.answersByCase ?? {}).some((replies) =>
        replies.some((reply) => reply.server === name),
      ),
    declaresSampling: ({ mock }) => mock && options.modelAnswers === true,
    useServerNames: (next) => {
      names = { ...names, ...next };
    },
    taskHandlers: {
      elicitation: async (params, ctx) =>
        answer({
          serverId: ctx.serverId,
          message: typeof params.message === "string" ? params.message : "",
          mode: params.mode === "url" ? "url" : "form",
        }),
    },
  };
}

/** The words a server's request for the model asks, as a system prompt and one prompt. */
function modelRequestWords(params: Record<string, unknown>): {
  system?: string;
  prompt: string;
} {
  const messages = Array.isArray(params.messages) ? params.messages : [];
  const lines = messages.flatMap((message) => {
    const content = (message as { content?: unknown })?.content;
    const blocks = Array.isArray(content) ? content : [content];
    return blocks.flatMap((block) =>
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text"
        ? [String((block as { text?: unknown }).text ?? "")]
        : [],
    );
  });
  return {
    ...(typeof params.systemPrompt === "string" && {
      system: params.systemPrompt,
    }),
    prompt: lines.join("\n\n"),
  };
}

const resolvers = new WeakMap<object, InputAnswerResolver>();

/** Remembers which resolver a connection was built with, for the runner's task seam. */
export function registerInputAnswerResolver(
  manager: MCPClientManager,
  resolver: InputAnswerResolver,
): void {
  resolvers.set(manager, resolver);
}

export function inputAnswerResolverOf(
  manager: MCPClientManager,
): InputAnswerResolver | undefined {
  return resolvers.get(manager);
}

const getCase = makeFunctionReference<
  "query",
  { testCaseId: string },
  { inputAnswers?: InputAnswer[] } | null
>("testSuites:getTestCase");
const listCases = makeFunctionReference<
  "query",
  { suiteId: string },
  Array<{ _id?: string; inputAnswers?: InputAnswer[] }>
>("testSuites:listTestCases");

/** A run's replies: all of them in case order, and each case's own by its id. */
export interface LoadedInputAnswers {
  pooled: InputAnswer[];
  byCase: Record<string, InputAnswer[]>;
}

/**
 * The replies a run gives, read before the connection opens because the
 * capability to be asked is declared when it connects. A suite run pools the
 * replies of its cases in case order (a question carries no case on the older
 * revisions, so entries that name a server, tool and message keep two cases
 * apart); a quick run takes its one case's.
 *
 * A failed read refuses the run: running on with no replies would decline every
 * question and change the result without saying so.
 */
export async function loadInputAnswers(
  convex: Pick<ConvexHttpClient, "query">,
  target: { suiteId?: unknown; testCaseId?: unknown },
): Promise<LoadedInputAnswers> {
  const none: LoadedInputAnswers = { pooled: [], byCase: {} };
  const named = (value: unknown) =>
    typeof value === "string" && value ? value : undefined;
  const testCaseId = named(target.testCaseId);
  const suiteId = named(target.suiteId);
  try {
    if (testCaseId) {
      const replies =
        (await convex.query(getCase, { testCaseId }))?.inputAnswers ?? [];
      return { pooled: replies, byCase: { [testCaseId]: replies } };
    }
    if (!suiteId) return none;
    const cases = await convex.query(listCases, { suiteId });
    const list = Array.isArray(cases) ? cases : [];
    return {
      pooled: list.flatMap((testCase) => testCase.inputAnswers ?? []),
      byCase: Object.fromEntries(
        list.flatMap((testCase) =>
          testCase._id ? [[testCase._id, testCase.inputAnswers ?? []]] : [],
        ),
      ),
    };
  } catch (error) {
    if (/Could not find public function/i.test(String(error))) return none;
    throw new WebRouteError(
      503,
      ErrorCode.INTERNAL_ERROR,
      "MCPJam couldn't load the replies saved on this suite's cases, so the run didn't start. Try again in a few minutes.",
    );
  }
}

/** The resolver for a run's target, with its replies loaded and no server named yet. */
export async function inputAnswerResolverFor(
  convex: Pick<ConvexHttpClient, "query">,
  target: { suiteId?: unknown; testCaseId?: unknown },
  options: { modelAnswers?: boolean } = {},
): Promise<InputAnswerResolver> {
  const loaded = await loadInputAnswers(convex, target);
  return createInputAnswerResolver({
    answers: loaded.pooled,
    answersByCase: loaded.byCase,
    modelAnswers: options.modelAnswers,
  });
}

const PINNED_TTL_MS = 60_000;
const PINNED_MAX_ENTRIES = 200;
const pinned = new Map<string, { at: number; answers: InputAnswer[] }>();

/**
 * The replies pinned on one harness iteration, for the proxy, which builds its
 * connection on every request and must declare the capability each time. The
 * token stays as it was; the replies are read from the backend by the run and
 * iteration the token names, and kept a minute because they never change once
 * an iteration exists.
 */
export async function loadPinnedInputAnswers(
  scope: { runId: string; iterationId: string },
  transport: HarnessEvidenceTransport = createConvexEvidenceTransport(),
  now: () => number = Date.now,
): Promise<InputAnswer[]> {
  const key = `${scope.runId}:${scope.iterationId}`;
  const hit = pinned.get(key);
  if (hit && now() - hit.at < PINNED_TTL_MS) return hit.answers;
  const response = await transport("input-answers", scope, {});
  const answers = (response.body as { inputAnswers?: unknown } | null)
    ?.inputAnswers;
  if (response.status !== 200 || !Array.isArray(answers)) {
    throw new Error(
      "MCPJam couldn't load the replies saved on this case, so the tool call didn't run. Try the run again.",
    );
  }
  if (pinned.size >= PINNED_MAX_ENTRIES) {
    pinned.delete(pinned.keys().next().value as string);
  }
  pinned.set(key, { at: now(), answers: answers as InputAnswer[] });
  return answers as InputAnswer[];
}
