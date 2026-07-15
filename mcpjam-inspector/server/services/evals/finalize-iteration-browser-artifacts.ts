/**
 * PR 6b: browser-rendered MCP App eval artifacts for the backend.
 *
 * The implementation moved to the shared
 * `services/browser-artifact-serialization.ts` (the synthetic-session runner
 * uses the same serializers + payload mappers per turn); this module re-exports
 * it so the eval persistence path keeps one import site. The serializers run
 * inside `finalizeEvalIteration` exactly ONCE per iteration, BEFORE the W2
 * per-turn fanout or the W1 single-call fallback consume the result, so a
 * screenshot blob is never uploaded twice.
 */
export {
  serializeBrowserStepsForBackend,
  serializeRenderObservationsForBackend,
  toBrowserStepPayload,
  toObservationPayload,
} from "../browser-artifact-serialization.js";
