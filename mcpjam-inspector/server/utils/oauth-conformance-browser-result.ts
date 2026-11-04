import {
  redactConformanceReportForSharing,
  redactUrlSecrets,
  type ConformanceResult,
} from "@mcpjam/sdk";

type HttpAttempt = ConformanceResult["steps"][number]["httpAttempts"][number];

/**
 * The OAuth conformance result as a hosted browser receives it.
 *
 * The raw result completes a real authorization, so it carries the client
 * secret (`credentials`, the token request's `Authorization: Basic` header or
 * body), the access and refresh tokens (`credentials`, the token response, the
 * step logs) and every request's headers. None of that is rendered: the step
 * rows and the saved report read each request's method, URL and status only.
 *
 * So the result gets the same redaction as a shared report — which drops
 * `credentials`, logs and the raw HTTP evidence and sweeps credential-shaped
 * keys — and then each step gets back just those request rows, with secret
 * query parameters removed from the URL.
 */
export function toBrowserOAuthResult(
  result: ConformanceResult
): ConformanceResult {
  const redacted = redactConformanceReportForSharing(result);
  return {
    ...redacted,
    steps: redacted.steps.map((step, index) => {
      const attempts = (result.steps[index]?.httpAttempts ?? []).map(
        toRequestRow
      );
      return {
        ...step,
        logs: [],
        httpAttempts: attempts,
        http: attempts[attempts.length - 1],
      };
    }),
  };
}

function toRequestRow(attempt: HttpAttempt): HttpAttempt {
  return {
    step: attempt.step,
    timestamp: attempt.timestamp,
    ...(attempt.duration !== undefined ? { duration: attempt.duration } : {}),
    request: {
      method: attempt.request.method,
      url: redactUrlSecrets(attempt.request.url),
      headers: {},
    },
    ...(attempt.response
      ? {
          response: {
            status: attempt.response.status,
            statusText: attempt.response.statusText,
            headers: {},
            body: undefined,
          },
        }
      : {}),
  };
}
