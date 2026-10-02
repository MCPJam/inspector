/**
 * Inspector-side client for the backend's tool-approval claim route
 * (`POST /internal/v1/tool-approvals/claim`; see mcpjam-backend
 * `convex/http.ts` + `convex/authSessions.ts`).
 *
 * The backend records each approval's claim durably and answers `claimed` to
 * the first caller for an approval and `already_claimed` to every caller
 * after it, whichever process asks. `tool-approval-token.ts` decides when to
 * call it; this module only speaks the wire contract:
 *
 *   request   {"nonceHash": "<sha256 hex>", "expiresAt": <epoch ms>}
 *   response  200 {"status": "claimed" | "already_claimed"}
 *
 * Authenticated with `INSPECTOR_SERVICE_TOKEN` via the
 * `x-inspector-service-token` header, like the other `/internal/v1/*` routes.
 */
import { logger } from "../utils/logger.js";

export const TOOL_APPROVAL_CLAIM_PATH = "/internal/v1/tool-approvals/claim";

/**
 * How long a claim may take before it counts as unconfirmed. The claim sits
 * between the user's approval and the call, on the request the user is
 * waiting on, so it is kept short.
 */
export const TOOL_APPROVAL_CLAIM_TIMEOUT_MS = 3_000;

/**
 * `unavailable` covers every answer that is not a well-formed 200: a network
 * error, a timeout, a non-2xx status, or a body outside the contract. The
 * caller must not run the call on it.
 */
export type RecordedToolApprovalClaim =
  "claimed" | "already_claimed" | "unavailable";

export async function recordToolApprovalClaim(args: {
  convexHttpUrl: string;
  serviceToken: string;
  nonceHash: string;
  expiresAt: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<RecordedToolApprovalClaim> {
  const url = `${args.convexHttpUrl.replace(/\/$/, "")}${TOOL_APPROVAL_CLAIM_PATH}`;
  const fetchImpl = args.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-inspector-service-token": args.serviceToken,
      },
      body: JSON.stringify({
        nonceHash: args.nonceHash,
        expiresAt: args.expiresAt,
      }),
      signal: AbortSignal.timeout(
        args.timeoutMs ?? TOOL_APPROVAL_CLAIM_TIMEOUT_MS,
      ),
    });
  } catch (error) {
    logger.warn("[tool-approval-claims] claim request failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "unavailable";
  }
  if (!response.ok) {
    logger.warn("[tool-approval-claims] claim request was not accepted", {
      status: response.status,
    });
    return "unavailable";
  }
  const body = (await response.json().catch(() => null)) as {
    status?: unknown;
  } | null;
  if (body?.status === "claimed" || body?.status === "already_claimed") {
    return body.status;
  }
  logger.warn("[tool-approval-claims] claim response was not understood", {
    status: response.status,
  });
  return "unavailable";
}
