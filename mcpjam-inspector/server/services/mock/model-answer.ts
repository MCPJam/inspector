/**
 * A model that answers a mock's tool: the same call gets the same answer.
 *
 * The first call of a mock version, tool and input asks a model to answer as
 * the server (`modelAnswerPrompt` in the SDK), counts it against the version's
 * and the run's cap before asking, and stores what came back; every call after
 * replays the stored answer with no model call. Two calls that arrive together
 * for one key share one model call. The backend holds the answers and the
 * counts (`convex/mockAnswers.ts`), so a second replica replays the first's.
 */
import { canonicalDigest } from "@mcpjam/sdk/contract";
import {
  MockAnswerError,
  modelAnswerPrompt,
  parseModelAnswer,
  type MockModelAnswerer,
} from "@mcpjam/sdk/mocks";
import { logger } from "../../utils/logger.js";
import type { AnswersBackend } from "./answers-backend.js";

/** Asks a model one question. The route's own is `hostedModelCaller`; tests give their own. */
export type ModelCaller = (request: {
  system: string;
  prompt: string;
  signal?: AbortSignal;
}) => Promise<{ text: string; model: string }>;

export interface ModelAnswererArgs {
  mockId: string;
  version: number;
  backend: AnswersBackend;
  callModel: ModelCaller;
  /** Names the run for the per-run cap; without one only the version's cap applies. */
  runKey?: string;
}

type Answered = Awaited<ReturnType<MockModelAnswerer>>;

/** One model call per key on this replica, however many calls ask at once. */
const inFlight = new Map<string, Promise<Answered>>();

export function createModelAnswerer(
  args: ModelAnswererArgs,
): MockModelAnswerer {
  return (request) => {
    const tool = request.tool.name;
    const key = {
      mockId: args.mockId,
      version: args.version,
      tool,
      inputHash: canonicalDigest({ tool, arguments: request.arguments }),
    };
    const flightKey = `${key.mockId}:${key.version}:${key.tool}:${key.inputHash}`;
    const running = inFlight.get(flightKey);
    if (running) return running;
    const answering = answer(args, key, request).finally(() =>
      inFlight.delete(flightKey),
    );
    inFlight.set(flightKey, answering);
    return answering;
  };
}

async function answer(
  args: ModelAnswererArgs,
  key: Parameters<AnswersBackend["lookup"]>[0],
  request: Parameters<MockModelAnswerer>[0],
): Promise<Answered> {
  const hasOutputSchema = Boolean(request.tool.outputSchema);
  const earlier = await args.backend.lookup(key);
  if (earlier) {
    return {
      result: parseStored(earlier.answerJson, hasOutputSchema),
      outcome: "stored",
    };
  }

  await args.backend.reserve({
    mockId: args.mockId,
    version: args.version,
    ...(args.runKey && { runKey: args.runKey }),
  });
  const { system, prompt } = modelAnswerPrompt(request);
  let reply: Awaited<ReturnType<ModelCaller>>;
  try {
    reply = await args.callModel({ system, prompt, signal: request.signal });
  } catch (error) {
    if (error instanceof MockAnswerError) throw error;
    if (request.signal?.aborted) throw error;
    logger.warn("[mock-route] the model that answers a mock failed", {
      error: error instanceof Error ? error.name : typeof error,
    });
    throw new MockAnswerError(
      `The model that answers ${key.tool} did not reply. Try the call again, or save answers for it instead.`,
    );
  }
  const result = parseModelAnswer(reply.text, hasOutputSchema);
  // A racing replica may have stored first; its answer stands for everyone.
  const standing = await args.backend.store(key, {
    answerJson: JSON.stringify(result),
    model: reply.model,
  });
  return {
    result: parseStored(standing.answerJson, hasOutputSchema),
    outcome: "generated",
  };
}

/** What was stored is a result as `parseModelAnswer` reads it back. */
const parseStored = parseModelAnswer;
