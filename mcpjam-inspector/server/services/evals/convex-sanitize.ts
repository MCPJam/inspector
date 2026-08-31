export {
  sanitizeForConvexTransport,
  desanitizeFromConvexTransport,
} from "@/shared/convex-sanitize";

/**
 * The exact persisted shape of one `testIteration.actualToolCalls` entry —
 * mirrors the backend's `evalIterationToolCallValidator` (mcpjam-backend
 * `convex/lib/evalAnalysis.ts`), which is a strict `v.object`.
 */
export type PersistedToolCall = {
  toolName: string;
  arguments: Record<string, unknown>;
  toolCallId?: string;
};

/**
 * Project tool calls onto exactly the fields that
 * `updateTestIteration.actualToolCalls` accepts, dropping anything else.
 *
 * Convex object validators are STRICT: one unrecognized field is a hard
 * `ArgumentValidationError`, not a silent drop — so an extra key here doesn't
 * degrade a write, it fails the whole iteration finalize. That is what
 * CONVEX-1QF was: the runner began attaching `toolCallId` (inspector #4308, to
 * filter policy-blocked calls by id) and every eval iteration carrying a tool
 * call stopped persisting until the validator was widened (backend #1134).
 *
 * Each producer currently builds these objects field-by-field, so today's
 * payload is already clean. This makes that a property of the boundary rather
 * than of every producer remembering: the runner reads tool calls out of
 * `any`-typed AI SDK step objects, so the next field added upstream would
 * otherwise reach the validator the same way.
 */
export function toPersistedToolCalls(
  toolCalls: ReadonlyArray<{
    toolName: string;
    arguments: Record<string, unknown>;
    toolCallId?: string;
  }>,
): PersistedToolCall[] {
  return toolCalls.map((call) => ({
    toolName: call.toolName,
    arguments: call.arguments,
    ...(typeof call.toolCallId === "string"
      ? { toolCallId: call.toolCallId }
      : {}),
  }));
}
