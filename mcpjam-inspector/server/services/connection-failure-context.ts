import {
  bodyKindFromContentType,
  summarizeBearerChallenge,
  describeError,
  type BearerChallengeSummary,
} from "@mcpjam/sdk";

type Capture = {
  pending: number;
  ambiguous: boolean;
  last?: { status: number; challenge: BearerChallengeSummary };
};

const captures = new WeakMap<typeof fetch, Capture>();

/** Read only the latest matching rejection from this server's own transport. */
export function connectionChallengeFor(
  baseFetch: typeof fetch | undefined,
  error: unknown,
): BearerChallengeSummary | undefined {
  const capture = baseFetch && captures.get(baseFetch);
  if (!capture || capture.ambiguous || capture.pending || !capture.last)
    return undefined;
  const normalized = describeError(error, {
    challenge: capture.last.challenge,
  });
  return normalized.rawCode === capture.last.status
    ? capture.last.challenge
    : undefined;
}

/** Observe headers without consuming bodies or changing fetch errors/retries. */
export function observeConnectionFetch(baseFetch: typeof fetch): typeof fetch {
  const capture: Capture = { pending: 0, ambiguous: false };
  const observed = (async (...args: Parameters<typeof fetch>) => {
    if (capture.pending === 0) capture.ambiguous = false;
    capture.pending += 1;
    if (capture.pending > 1) capture.ambiguous = true;
    capture.last = undefined;
    try {
      const response = await baseFetch(...args);
      if (
        !capture.ambiguous &&
        (response.status === 401 || response.status === 403)
      ) {
        capture.last = {
          status: response.status,
          challenge: summarizeBearerChallenge(
            response.headers.get("www-authenticate"),
            {
              bodyKind: bodyKindFromContentType(
                response.headers.get("content-type"),
                response.headers.get("content-length") === "0" ? 0 : undefined,
              ),
            },
          ),
        };
      }
      return response;
    } finally {
      capture.pending -= 1;
    }
  }) as typeof fetch;
  captures.set(observed, capture);
  return observed;
}
