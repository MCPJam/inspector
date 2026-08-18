import { Hono } from "hono";
import { z } from "zod";
import {
  ErrorCode,
  WebRouteError,
  assertBearerToken,
  handleRoute,
  parseWithSchema,
  readJsonBody,
} from "./auth.js";
import { redeemScenarioToken } from "../../utils/scenario-redeem.js";

const scenarios = new Hono();

// Token redemption. The landing page calls this on mount to exchange its
// URL token for `{ scenarioId, role, mode, projectId, accessVersion,
// bootstrap }`. Once the inspector stores `scenarioId` + `accessVersion`,
// subsequent calls do NOT need the token — every read-path route accepts
// `scenarioId` directly.
//
// `bootstrap` is the same payload shape callers previously fetched from
// `/scenario/bootstrap` (projectId, hostStyle, modelId, systemPrompt,
// servers, …). Inspector clients validate the whole shape before storing
// the session — see `ScenarioBootstrapPayload` in `scenario-session.ts`.
//
// Thin forward to the Convex /web/scenario/redeem endpoint; the backend
// handles rate limits, audit, and access-grant writes. The fetch/parse
// logic lives in utils/scenario-redeem.ts so non-route callers can reuse
// it.
const scenarioRedeemSchema = z.object({
  scenarioToken: z.string().min(1),
});

function mapRedeemStatusToErrorCode(status: number): ErrorCode {
  if (status === 401) return ErrorCode.UNAUTHORIZED;
  if (status === 403) return ErrorCode.FORBIDDEN;
  if (status === 404) return ErrorCode.NOT_FOUND;
  if (status === 429) return ErrorCode.RATE_LIMITED;
  // 410 Gone (the scenario's environment was archived) and 409 (it can't be
  // resolved right now) are both "the link is fine, the thing behind it is
  // not" — a state conflict, not a bad request and not our fault. See the
  // CONFLICT doc in ./errors.ts.
  if (status === 409 || status === 410) return ErrorCode.CONFLICT;
  if (status === 502 || status === 503 || status === 504) {
    return ErrorCode.SERVER_UNREACHABLE;
  }
  return ErrorCode.INTERNAL_ERROR;
}

scenarios.post("/redeem", async (c) =>
  handleRoute(c, async () => {
    if (!process.env.CONVEX_HTTP_URL) {
      throw new WebRouteError(
        500,
        ErrorCode.INTERNAL_ERROR,
        "Server missing CONVEX_HTTP_URL configuration",
      );
    }

    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(
      scenarioRedeemSchema,
      await readJsonBody<unknown>(c),
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let result;
    try {
      result = await redeemScenarioToken({
        scenarioToken: body.scenarioToken,
        bearer: bearerToken,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!result.ok) {
      throw new WebRouteError(
        result.status || 500,
        mapRedeemStatusToErrorCode(result.status),
        result.error,
        // The backend's domain code rides in `details`, not the top level:
        // the top-level `code` is this route's TRANSPORT classification, and
        // collapsing the two would make `ENV_ARCHIVED` look like an
        // inspector-side error code. Same split `readEnvironmentErrorPayload`
        // documents on the client.
        result.code ? { code: result.code } : undefined,
      );
    }

    return {
      scenarioId: result.scenarioId,
      role: result.role,
      mode: result.mode,
      projectId: result.projectId,
      accessVersion: result.accessVersion,
      bootstrap: result.bootstrap,
    };
  }),
);

export default scenarios;
