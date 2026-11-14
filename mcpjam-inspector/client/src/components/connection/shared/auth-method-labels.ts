import type { ServerFormAuthType } from "@/shared/types.js";

/** What each auth method is called wherever a server's auth is shown: the
 * Config form's Authentication select and the Auth tab's summary. */
export const AUTH_METHOD_LABELS: Record<ServerFormAuthType, string> = {
  auto: "Auto",
  none: "No Authentication",
  bearer: "Bearer Token",
  oauth: "OAuth",
  xaa: "Cross-App Access (XAA)",
};
