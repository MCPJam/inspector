/**
 * Test-support alias for the raw wire capture primitive.
 *
 * The primitive itself was promoted into production in Phase 7 §15.5 — it now
 * lives at `src/mcp-conformance/raw-capture.ts` so the conformance runner
 * (production code) can depend on it without importing from `tests/`. This
 * module re-exports it verbatim so existing test imports keep working and
 * there is exactly ONE implementation of capture/SSE parsing in the repo.
 */

export {
  createCapturingFetch,
  getWireField,
  hasWireField,
  parseSseEvents,
  redactHeadersForLog,
} from "../../src/mcp-conformance/raw-capture.js";

export type {
  CapturingFetch,
  FetchLike,
  RawExchange,
  RawRequest,
  RawResponse,
  RawSseEvent,
} from "../../src/mcp-conformance/raw-capture.js";
