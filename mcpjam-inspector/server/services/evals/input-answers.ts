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
  ElicitationCallback,
  ElicitationCallbackRequest,
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

/** The tool call a question belongs to, and where to record the exchange. */
export interface ToolCallScope {
  tool: string;
  serverId?: string;
  record?: (exchange: InputExchange) => void;
}

const toolCallScope = new AsyncLocalStorage<ToolCallScope>();
const caseScope = new AsyncLocalStorage<string | undefined>();

export function withInputAnswerCaseScope<T>(caseId: string | undefined, run: () => T): T {
  return caseScope.run(caseId, run);
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
  /** Tasks: the same answers, for the task driver's input slot. */
  readonly taskHandlers: TaskInputHandlers;
  /** Names the connection's servers once they are authorized, so a reply can fit on `server`. */
  useServerNames(names: Record<string, string>): void;
}

export interface InputAnswerResolverOptions {
  answers: readonly InputAnswer[];
  answersByCase?: ReadonlyMap<string, readonly InputAnswer[]>;
  /** The server's name as the suite names it, from the connection's server id. */
  serverName?: (serverId: string) => string | undefined;
}

type Reply = ReturnType<typeof inputAnswerResult>;

export function createInputAnswerResolver(
  options: InputAnswerResolverOptions,
): InputAnswerResolver {
  const exchanges: InputExchange[] = [];
  let names: Record<string, string> = {};

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
    const caseId = caseScope.getStore();
    const answers = options.answersByCase
      ? (caseId === undefined ? undefined : options.answersByCase.get(caseId)) ?? []
      : options.answers;
    const matched = matchInputAnswer(answers, {
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
      ...(!matched && {
        note: "declined, no reply was set for this question",
      }),
    };
    exchanges.push(exchange);
    scope?.record?.(exchange);
    return reply;
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
    collectorFor:
      (serverId) =>
      async ({ state, inputRequests }) => {
        const tool =
          state.method === "tools/call" &&
          typeof state.originalParams.name === "string"
            ? state.originalParams.name
            : undefined;
        const responses: Record<string, Reply> = {};
        for (const [key, request] of Object.entries(inputRequests)) {
          const params = (request.params ?? {}) as Record<string, unknown>;
          responses[key] = answer({
            serverId,
            message: typeof params.message === "string" ? params.message : "",
            mode: params.mode === "url" ? "url" : "form",
            tool,
          });
        }
        return responses;
      },
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
  Array<{ _id: string; inputAnswers?: InputAnswer[]; disabled?: boolean }>
>("testSuites:listTestCases");

async function loadInputAnswerPlan(
  convex: Pick<ConvexHttpClient, "query">,
  target: { suiteId?: unknown; testCaseId?: unknown },
): Promise<InputAnswerResolverOptions> {
  const testCaseId = typeof target.testCaseId === "string" && target.testCaseId;
  const suiteId = typeof target.suiteId === "string" && target.suiteId;
  try {
    if (testCaseId) {
      return { answers: (await convex.query(getCase, { testCaseId }))?.inputAnswers ?? [] };
    }
    if (!suiteId) return { answers: [] };
    const cases = await convex.query(listCases, { suiteId });
    return {
      answers: cases.flatMap((testCase) => testCase.inputAnswers ?? []),
      answersByCase: new Map(cases.map((testCase) => [testCase._id, testCase.inputAnswers ?? []])),
    };
  } catch (error) {
    if (/Could not find public function/i.test(String(error))) return { answers: [] };
    throw new WebRouteError(
      503,
      ErrorCode.INTERNAL_ERROR,
      "MCPJam couldn't load the replies saved on this suite's cases, so the run didn't start. Try again in a few minutes.",
    );
  }
}

/** Replies must be known before the connection advertises elicitation. */
export async function loadInputAnswers(
  convex: Pick<ConvexHttpClient, "query">,
  target: { suiteId?: unknown; testCaseId?: unknown },
): Promise<readonly InputAnswer[]> {
  return (await loadInputAnswerPlan(convex, target)).answers;
}

export async function inputAnswerResolverFor(
  convex: Pick<ConvexHttpClient, "query">,
  target: { suiteId?: unknown; testCaseId?: unknown },
): Promise<InputAnswerResolver | undefined> {
  const plan = await loadInputAnswerPlan(convex, target);
  return plan.answers.length ? createInputAnswerResolver(plan) : undefined;
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
