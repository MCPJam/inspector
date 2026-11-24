/**
 * The backend's side of a model answer: the stored answers and the count that
 * caps how many a mock version, or one run, may make. The route holds neither,
 * so every replica replays the same answer and counts against the same limit.
 * It refuses to answer when the backend cannot be asked: an answer that was
 * neither counted nor stored would be an unmetered model call.
 */
import { MockAnswerError } from "@mcpjam/sdk/mocks";
import {
  buildConvexAuthHeaders,
  type ManagerCallerContext,
} from "../../routes/web/auth.js";
import { logger } from "../../utils/logger.js";

const TIMEOUT_MS = 10_000;
const UNAVAILABLE =
  "MCPJam could not reach its store of mock answers just now. Try the call again in a minute.";

export interface StoredModelAnswer {
  answerJson: string;
  model: string;
}

export interface AnswerKey {
  mockId: string;
  version: number;
  tool: string;
  inputHash: string;
}

/** What `model-answer.ts` needs from the backend; tests supply their own. */
export interface AnswersBackend {
  lookup(key: AnswerKey): Promise<StoredModelAnswer | undefined>;
  /** Counts one model call; throws `MockAnswerError` with the backend's words past a cap. */
  reserve(args: {
    mockId: string;
    version: number;
    runKey?: string;
  }): Promise<void>;
  /** Stores the answer unless one is already stored; returns the one that stands. */
  store(key: AnswerKey, answer: StoredModelAnswer): Promise<StoredModelAnswer>;
}

export function convexAnswersBackend(
  caller: ManagerCallerContext,
  bearerToken: string,
  deps: { fetch?: typeof fetch } = {},
): AnswersBackend {
  async function post(path: string, body: object): Promise<Response> {
    const convexUrl = process.env.CONVEX_HTTP_URL;
    if (!convexUrl) {
      logger.warn(
        "[mock-route] CONVEX_HTTP_URL is not set; cannot reach the mock answer store",
      );
      throw new MockAnswerError(UNAVAILABLE);
    }
    try {
      return await (deps.fetch ?? fetch)(
        `${convexUrl}/web/mock/answers/${path}`,
        {
          method: "POST",
          headers: buildConvexAuthHeaders(caller, bearerToken),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
    } catch (error) {
      logger.warn("[mock-route] the mock answer store did not answer", {
        path,
        error: error instanceof Error ? error.name : typeof error,
      });
      throw new MockAnswerError(UNAVAILABLE);
    }
  }

  /** The body of an answered request, or the refusal in the backend's own words. */
  async function bodyOf(
    response: Response,
    path: string,
  ): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> = {};
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      // Not JSON: the status alone decides below.
    }
    if (response.ok) return body;
    logger.warn("[mock-route] the mock answer store refused a request", {
      path,
      status: response.status,
    });
    throw new MockAnswerError(
      response.status === 429 && typeof body.message === "string"
        ? body.message
        : UNAVAILABLE,
    );
  }

  const stored = (body: Record<string, unknown>): StoredModelAnswer => {
    if (typeof body.answerJson !== "string" || typeof body.model !== "string") {
      throw new MockAnswerError(UNAVAILABLE);
    }
    return { answerJson: body.answerJson, model: body.model };
  };

  return {
    lookup: async (key) => {
      const body = await bodyOf(await post("lookup", key), "lookup");
      return body.found === true ? stored(body) : undefined;
    },
    reserve: async (args) => {
      await bodyOf(await post("reserve", args), "reserve");
    },
    store: async (key, answer) =>
      stored(await bodyOf(await post("store", { ...key, ...answer }), "store")),
  };
}
