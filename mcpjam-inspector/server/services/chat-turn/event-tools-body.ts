import {
  EventToolsSnapshotError,
  validateEventToolsSnapshot,
  type EventToolsSnapshot,
} from "@/shared/event-agent-tools";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";

/**
 * The Playground's MCP Events agent-tools snapshot (`body.eventTools`),
 * checked at the route boundary like the app- and page-tool snapshots: a
 * malformed one is a 400 before any tool is built.
 */
export function eventToolsFromBody(
  input: unknown,
): EventToolsSnapshot | undefined {
  try {
    return validateEventToolsSnapshot(input);
  } catch (error) {
    if (error instanceof EventToolsSnapshotError) {
      throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, error.message);
    }
    throw error;
  }
}
