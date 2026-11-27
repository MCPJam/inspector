/**
 * The one question the route asks the backend right before it lets a call
 * reach a mock's real server: does the workspace's forwarding policy allow it
 * now, and may this caller still use the base? Nothing is remembered; every
 * dispatch asks again, and a read that fails is not an answer.
 *
 * ASSUMPTION (B2 is not settled): `POST /web/mock/forward-check` takes
 * `{ mockId, version }` (or `{ grant }` from the in-process door) as the
 * caller and answers `{ allowed: true }` or `{ allowed: false, reason }`
 * with `reason` one of `blocked_by_policy` and `no_access`. A 401, 403 or 404 means
 * the caller lost access. This file is the only place that knows the route.
 */
import { buildConvexAuthHeaders, type ManagerCallerContext } from "../../routes/web/auth.js";

const CHECK_TIMEOUT_MS = 10_000;

export type ForwardVerdict =
  | { allowed: true }
  | { allowed: false; reason: "blocked_by_policy" | "no_access" };

/** What a refused forward tells the caller: what happened and what to do next. */
export const FORWARD_REFUSAL_MESSAGES = {
  blocked_by_policy:
    "Your workspace does not allow mock servers to call their real servers. Ask a workspace admin to allow it, or save an answer for this call.",
  no_access:
    "You no longer have access to the real server behind this mock. Ask a project member to add you, then try again.",
} as const;

export interface ForwardCheckInput {
  mockId: string;
  version: number;
  caller: ManagerCallerContext;
  bearerToken: string;
  /** In process only: the grant the dialer holds. */
  grant?: string;
  signal?: AbortSignal;
}

/** Throws when the policy cannot be read; the runtime then refuses the forward without dispatching. */
export async function checkForwardWithBackend(
  input: ForwardCheckInput,
  deps: { fetch?: typeof fetch } = {},
): Promise<ForwardVerdict> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) throw new Error("The backend address is not set, so the forwarding policy cannot be read.");
  const signals = [AbortSignal.timeout(CHECK_TIMEOUT_MS), ...(input.signal ? [input.signal] : [])];
  const response = await (deps.fetch ?? fetch)(`${convexUrl}/web/mock/forward-check`, {
    method: "POST",
    headers: buildConvexAuthHeaders(input.caller, input.bearerToken),
    body: JSON.stringify(
      input.grant ? { grant: input.grant } : { mockId: input.mockId, version: input.version },
    ),
    signal: AbortSignal.any(signals),
  });
  if (response.status === 401 || response.status === 403 || response.status === 404) return { allowed: false, reason: "no_access" };
  if (!response.ok) throw new Error(`The forwarding policy read answered ${response.status}.`);
  const body = (await response.json()) as { allowed?: unknown; reason?: unknown };
  if (body.allowed === true) return { allowed: true };
  if (body.allowed === false) {
    return { allowed: false, reason: body.reason === "no_access" ? "no_access" : "blocked_by_policy" };
  }
  throw new Error("The forwarding policy read answered in a shape this build cannot read.");
}
