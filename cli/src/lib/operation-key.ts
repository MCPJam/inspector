import { usageError } from "./output.js";

/**
 * The request `_meta` key a mock reads to make a write safe to retry. It is
 * the SDK's `OPERATION_KEY_META` (`@mcpjam/sdk/mocks`), spelled out here so a
 * `tools call` does not load the mock runtime; a test pins the two together.
 */
export const OPERATION_KEY_META = "mcpjam.com/operationKey";

const MAX_OPERATION_KEY_LENGTH = 256;

/** `_meta` for a call retried under `--operation-key`, or undefined without one. */
export function operationKeyMetadata(key: string | undefined): Record<string, string> | undefined {
  if (key === undefined) return undefined;
  if (key.length < 1 || key.length > MAX_OPERATION_KEY_LENGTH) {
    throw usageError(
      `--operation-key must be 1 to ${MAX_OPERATION_KEY_LENGTH} characters. Use a shorter key, such as a UUID.`,
    );
  }
  return { [OPERATION_KEY_META]: key };
}
