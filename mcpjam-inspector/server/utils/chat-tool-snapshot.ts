import type { PersistChatSessionOptions } from "./chat-ingestion.js";
import { prepareToolSnapshotTransport } from "./tool-snapshot-upload.js";
import { logger } from "./logger.js";

/** Catalog capture is best effort; a missing archive must not lose a turn. */
export async function prepareChatToolSnapshot(
  options: PersistChatSessionOptions,
): Promise<PersistChatSessionOptions> {
  if (!options.toolSnapshot) return options;
  try {
    const snapshot: unknown = options.secretScrubber
      ? JSON.parse(
          options.secretScrubber.scrubSerializedJson(
            JSON.stringify(options.toolSnapshot),
          ),
        )
      : options.toolSnapshot;
    const transport = await prepareToolSnapshotTransport({
      snapshot,
      bearerToken: options.authHeader?.replace(/^Bearer\s+/i, ""),
      scope: { purpose: "tool-snapshot", projectId: options.projectId ?? "" },
    });
    return { ...options, toolSnapshot: undefined, ...transport };
  } catch (error) {
    // Saving without catalog evidence is safe; the transcript remains complete.
    logger.debug("Chat tool snapshot unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ...options,
      toolSnapshot: undefined,
      toolSnapshotUnavailable: true,
    };
  }
}
