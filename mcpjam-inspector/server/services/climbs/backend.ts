/**
 * The climb functions of the backend, by name, and how their refusals reach a
 * caller. Every call carries the caller's own Convex bearer: the backend checks
 * the tier (view for a read, edit for anything that starts runs) and the
 * `climbs` flag, and answers a refusal as a `ConvexError` whose `code` is
 * stable and whose message says what failed and what to do next.
 */
import { makeFunctionReference } from "convex/server";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import { convexErrorData, translateConvexWriteError } from "../../routes/v1/convex-errors.js";
import { translateConvexReadError } from "../../routes/v1/convex-read-errors.js";

const query = (name: string) => makeFunctionReference<"query">(name);
const mutation = (name: string) => makeFunctionReference<"mutation">(name);

export const climbFns = {
  start: mutation("climbs:startClimb"),
  update: mutation("climbs:updateClimb"),
  get: query("climbs:getClimb"),
  list: query("climbs:listClimbs"),
  beginBaseline: mutation("climbs:beginClimbBaseline"),
  recordRunLaunch: mutation("climbSettle:recordClimbRunLaunch"),
  settleUnit: mutation("climbSettle:settleClimbUnit"),
  stop: mutation("climbRounds:stopClimb"),
  planRound: query("climbRounds:planClimbRound"),
  beginRound: mutation("climbRounds:beginClimbRound"),
  getRound: query("climbRounds:getClimbRound"),
  setDecision: mutation("climbRounds:setClimbRoundDecision"),
  failUnit: mutation("climbSettle:failClimbUnit"),
  estimate: query("testSuites:estimateSuiteRunCredits"),
  createMock: mutation("mockServers:createMock"),
  getMock: query("mockServers:getMock"),
};

/** What a refusal's code means for the HTTP answer. A code not listed here is the caller's input. */
const CONFLICTS = new Set([
  "CLIMB_BASELINE_DONE",
  "CLIMB_BUSY",
  "CLIMB_CASE_ALREADY_RUN",
  "CLIMB_CONFIRMATION_SPENT",
  "CLIMB_CONFIRMED",
  "CLIMB_CREDIT_LIMIT_REACHED",
  "CLIMB_MEASURE_LOCKED",
  "CLIMB_MEASURE_NOT_RECORDED",
  "CLIMB_NOT_READY",
  "CLIMB_NOT_STOPPED",
  "CLIMB_NOTHING_TO_CONFIRM",
  "CLIMB_NOTHING_TO_FIX_FOR_PASS_RATE",
  "CLIMB_NOTHING_TO_VERIFY",
  "CLIMB_NO_CONFIRMATION_CASES",
  "CLIMB_ROUND_IN_FLIGHT",
  "CLIMB_ROUND_LIMIT_REACHED",
  "CLIMB_ROUND_NOT_SETTLED",
  "CLIMB_STOPPED",
  "CLIMB_VERIFICATION_LIMIT_REACHED",
]);
const NOT_FOUND = new Set(["CLIMB_NOT_FOUND", "CLIMB_ROUND_NOT_FOUND", "CLIMB_SERVER_NOT_FOUND"]);

/** The backend's own refusal as a public error, or undefined for anything else. */
function climbRefusal(error: unknown): WebRouteError | undefined {
  const data = convexErrorData(error);
  const code = typeof data?.code === "string" ? data.code : "";
  if (!code.startsWith("CLIMB_")) return undefined;
  const { code: _code, message, ...extra } = data as Record<string, unknown>;
  const text = typeof message === "string" && message.trim() ? message : "The climb request was refused.";
  const details = { code, ...extra };
  if (NOT_FOUND.has(code)) return new WebRouteError(404, ErrorCode.NOT_FOUND, text, details);
  if (CONFLICTS.has(code)) return new WebRouteError(409, ErrorCode.CONFLICT, text, details);
  return new WebRouteError(400, ErrorCode.VALIDATION_ERROR, text, details);
}

export function translateClimbWriteError(error: unknown): WebRouteError {
  return (
    climbRefusal(error) ??
    translateConvexWriteError(error, {
      resource: "Climb",
      conflictMessage: "The climb changed while this request ran. Read it again, then retry.",
      fallbackMessage: "Climb request rejected",
    })
  );
}

export function translateClimbReadError(error: unknown): WebRouteError {
  return (
    climbRefusal(error) ??
    translateConvexReadError(error, {
      scope: "v1.climbs",
      notFoundMessage: "Climb not found",
      redactedIsRefusal: true,
    })
  );
}
