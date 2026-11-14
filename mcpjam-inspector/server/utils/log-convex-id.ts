import { isLogConvexIdShape } from "../../shared/strict-log.js";

declare const LOG_CONVEX_ID: unique symbol;
/**
 * A Convex ID from a server-side check: a Convex authorization response, or
 * the stored binding of a credential this server verified. The `orgId`,
 * `projectId` and `serverId` log context slots take only this type, and log
 * rows copy them from that context alone, never from an event payload or a
 * legacy `logger.*` context. A value that arrived in a request body, path or
 * header is not one, whatever its shape.
 */
export type LogConvexId = string & { readonly [LOG_CONVEX_ID]: true };

/**
 * Brands a value one of those checks produced. Checks only the shape, so a
 * malformed value becomes null instead of reaching a row.
 */
export function logConvexId(
  value: string | null | undefined,
): LogConvexId | null {
  return isLogConvexIdShape(value) ? (value as LogConvexId) : null;
}
