/**
 * Shared persistence for one "session in a host" turn.
 *
 * Both the live-chat path (`web-chat-turn.ts` → `buildOnConversationComplete`)
 * and the synthetic runner (`sessionSimulation/runner.ts` → `runOneSession`)
 * persist a `chatSessions` row after each assistant turn. The tool-snapshot
 * capture that precedes the write was duplicated byte-for-byte at both sites;
 * this module owns it once. Each caller still constructs its OWN persist
 * payload (direct chat: `resumeConfig` / `hostConfig` / `directVisibility`;
 * synthetic: `synthetic` / `personaId` / `synthesisRunId`) — we deliberately
 * do NOT fold those divergent shapes into one wide options union.
 */

import type { Context } from "hono";
import type { MCPClientManager } from "@mcpjam/sdk";
import { exportConnectedServerToolSnapshotForEvalAuthoring } from "./export-helpers.js";
import {
  persistChatSessionToConvex,
  type PersistChatSessionOptions,
} from "./chat-ingestion.js";

type Manager = InstanceType<typeof MCPClientManager>;

/**
 * Best-effort tool-snapshot capture. Filters to servers the manager actually
 * has connected, then exports the eval-authoring snapshot. Any failure resolves
 * to `undefined` — capturing a snapshot must NEVER block the session persist.
 */
export async function captureToolSnapshotForPersist(
  manager: Manager,
  selectedServerIds: string[],
  logPrefix: string,
): Promise<unknown> {
  try {
    const knownIds =
      typeof manager.hasServer === "function"
        ? selectedServerIds.filter((id) => manager.hasServer(id))
        : selectedServerIds;
    if (knownIds.length === 0) return undefined;
    return await exportConnectedServerToolSnapshotForEvalAuthoring(
      manager,
      knownIds,
      { logPrefix },
    );
  } catch {
    return undefined;
  }
}

/**
 * Capture the tool snapshot (best-effort) and persist the `chatSessions` row.
 * The caller supplies the full persist payload minus `toolSnapshot`; the
 * captured snapshot is merged in when present.
 */
export async function persistHostSessionTurn(
  manager: Manager,
  args: {
    selectedServerIds: string[];
    /** Default `true`; surfaces with synthetic server ids opt out. */
    captureToolSnapshot?: boolean;
    logPrefix: string;
    persist: Omit<PersistChatSessionOptions, "toolSnapshot">;
  },
  c?: Context,
): Promise<void> {
  const toolSnapshot =
    args.captureToolSnapshot !== false
      ? await captureToolSnapshotForPersist(
          manager,
          args.selectedServerIds,
          args.logPrefix,
        )
      : undefined;
  const merged = {
    ...args.persist,
    ...(toolSnapshot ? { toolSnapshot } : {}),
  };
  // Preserve the original call arity — only forward the Hono context when one
  // was actually supplied. Passing an explicit `undefined` second arg is both
  // unnecessary and changes `toHaveBeenCalledWith` matching for callers.
  if (c) {
    await persistChatSessionToConvex(merged, c);
  } else {
    await persistChatSessionToConvex(merged);
  }
}
