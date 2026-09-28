import { readExecutionRecord } from "@mcpjam/sdk";

/**
 * The public projection of an iteration's execution record
 * (`testIteration.execution`): what the iteration actually ran on.
 *
 * Re-read through the SDK's reader rather than passed through, so only the
 * contract's known keys cross this boundary — a stray field on the stored row
 * never does. OMITTED for a row written before the record existed, and for a
 * malformed one: "not recorded", never reconstructed from the case's model.
 */
export function toExecutionProjection(value: unknown) {
  const execution = readExecutionRecord(value);
  return execution ? { execution } : {};
}
