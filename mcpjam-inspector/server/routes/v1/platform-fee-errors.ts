import { ErrorCode, WebRouteError } from "../web/errors.js";
import type { ConvexErrorData } from "./convex-error-data.js";

export const PLATFORM_FEE_ERROR_CODES = [
  "platform_fee_refused",
  "ORGANIZATION_SPEND_BUDGET_REACHED",
  "platform_fee_unavailable",
  "client_upgrade_required",
  "ADMISSION_CONFLICT",
  "ADMISSION_CLOSED",
  "ADMISSION_NOT_FOUND",
];

export function translatePlatformFeeError(
  data: ConvexErrorData | null,
): WebRouteError | undefined {
  const code = data?.code;
  if (
    typeof code !== "string" ||
    !PLATFORM_FEE_ERROR_CODES.includes(code) ||
    typeof data?.message !== "string"
  )
    return undefined;
  const details: Record<string, unknown> = { code };
  if (typeof data.organizationId === "string")
    details.organizationId = data.organizationId;
  if (typeof data.reason === "string") details.reason = data.reason;
  // Held credits travel as insufficient_credits; the cause keeps the remedy apart.
  if (data.cause === "credits_reserved") details.cause = data.cause;
  if (
    code === "platform_fee_refused" ||
    code === "ORGANIZATION_SPEND_BUDGET_REACHED"
  ) {
    if (code === "ORGANIZATION_SPEND_BUDGET_REACHED")
      details.reason = "spend_budget_reached";
    return new WebRouteError(
      402,
      ErrorCode.PAYMENT_REQUIRED,
      data.message,
      details,
    );
  }
  if (code === "platform_fee_unavailable") {
    return new WebRouteError(
      503,
      ErrorCode.INTERNAL_ERROR,
      data.message,
      details,
    );
  }
  if (code === "client_upgrade_required") {
    if (typeof data.minimumVersion === "string")
      details.minimumVersion = data.minimumVersion;
    if (typeof data.docsUrl === "string") details.docsUrl = data.docsUrl;
    return new WebRouteError(
      426,
      ErrorCode.UPGRADE_REQUIRED,
      data.message,
      details,
    );
  }
  if (code === "ADMISSION_CONFLICT" || code === "ADMISSION_CLOSED") {
    return new WebRouteError(409, ErrorCode.CONFLICT, data.message, details);
  }
  if (code === "ADMISSION_NOT_FOUND") {
    return new WebRouteError(404, ErrorCode.NOT_FOUND, data.message, details);
  }
  return undefined;
}
