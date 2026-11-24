/**
 * The record of calls no saved answer matched. The route reports each to the
 * backend, which keeps a small bounded list per mock, so every replica and
 * every reader (`get_mock_server`) sees the same list. This is a note for the
 * person tuning the mock, never part of a call's outcome: a failure to write
 * it is logged and the call it came from is untouched.
 */
import {
  buildConvexAuthHeaders,
  type ManagerCallerContext,
} from "../../routes/web/auth.js";
import { logger } from "../../utils/logger.js";
import { digestOf } from "./backend.js";
import { AnswerCache } from "./limits.js";

const RECORD_TIMEOUT_MS = 5_000;
/** The same call is reported once a minute at most; the backend counts only what it is told. */
const REPORT_TTL_MS = 60_000;
/** The backend keeps this many bytes of an input; the route sends no more. */
const MAX_INPUT_JSON_BYTES = 8_192;

export interface UnmatchedCall {
  mockId: string;
  version: number;
  tool: string;
  arguments: Record<string, unknown>;
}

export interface UnmatchedRecorderInput {
  caller: ManagerCallerContext;
  bearerToken: string;
  calls: UnmatchedCall[];
}

const reported = new AnswerCache<true>(REPORT_TTL_MS);

/** Test seam. */
export function resetUnmatchedReportsForTests(): void {
  reported.clear();
}

export async function recordUnmatchedCalls(
  { caller, bearerToken, calls }: UnmatchedRecorderInput,
  deps: { fetch?: typeof fetch } = {},
): Promise<void> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) return;
  for (const call of calls) {
    const argumentsJson = JSON.stringify(call.arguments);
    const key = digestOf(call.mockId, call.version, call.tool, argumentsJson);
    if (reported.get(key)) continue;
    reported.set(key, true);
    // The backend keeps the tool and a digest even when the input is too big to show.
    const shown =
      Buffer.byteLength(argumentsJson) > MAX_INPUT_JSON_BYTES
        ? {}
        : call.arguments;
    try {
      const response = await (deps.fetch ?? fetch)(
        `${convexUrl}/web/mock/unmatched`,
        {
          method: "POST",
          headers: buildConvexAuthHeaders(caller, bearerToken),
          body: JSON.stringify({
            mockId: call.mockId,
            version: call.version,
            tool: call.tool,
            inputHash: key,
            arguments: shown,
          }),
          signal: AbortSignal.timeout(RECORD_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        logger.warn(
          "[mock-route] the backend did not take a record of an unmatched call",
          {
            status: response.status,
          },
        );
      }
    } catch (error) {
      logger.warn("[mock-route] recording an unmatched call did not complete", {
        error: error instanceof Error ? error.name : typeof error,
      });
    }
  }
}
