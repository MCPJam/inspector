import { ErrorCode, WebRouteError } from "../web/errors.js";
import type { ConvexErrorData } from "./convex-error-data.js";

export function translatePlatformFeeError(
  data: ConvexErrorData | null,
): WebRouteError | undefined {
  const code = data?.code;
  if (typeof data?.message !== "string") return undefined;
  const details: Record<string, unknown> = { code };
  if (typeof data.reason === "string") details.reason = data.reason;
  if (code === "platform_fee_refused") {
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
  return undefined;
}
