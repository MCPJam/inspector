/**
 * What a persisted conversation says about the target it ACTUALLY ran on, and
 * whether the composer currently describes that target or something else.
 *
 * ## Why this exists
 *
 * Opening `/playground?conversation=<id>` restores the transcript but not the
 * configuration: the previewed host and the previewed environment are ambient,
 * per-project browser state (`use-previewed-client-id`,
 * `use-previewed-environment-id`), so a reopened conversation renders under
 * whatever the viewer last had selected. The chips read as a statement about
 * the conversation — "this ran on cli-box-host, Claude Sonnet 5, no
 * environment" — when they are only a statement about the viewer. A reply typed
 * there then runs on that ambient target, which is how a Cursor-harness
 * transcript ends up answering a follow-up as Claude.
 *
 * ## What is actually recoverable
 *
 * The direct-chat detail read returns the whole `chatSessions` document, so
 * anything on the row reaches the browser. Of the execution facts:
 *
 *   - `modelId` — recorded, and already restored by `loadHistorySession`.
 *   - `resumeConfig.selectedServers` — recorded, already restored.
 *   - `resumeConfig.environmentId` — recorded ONLY for `origin: "api"`
 *     sessions (the Agent Playground turn route pins it; see
 *     `server/routes/v1/chat-session-turn.ts`). Browser Playground turns write
 *     a `resumeConfig` that has no target field at all
 *     (`server/utils/web-chat-turn.ts`).
 *   - `hostId` — stamped at ingest only for scenario- and swarm-sourced
 *     sessions, and those are never served by the direct-chat read. Declared
 *     here anyway so the moment the backend starts stamping it for direct
 *     chats this module reports it instead of "unrecorded".
 *
 * So for the overwhelming majority of Playground conversations the as-run
 * target is genuinely NOT PERSISTED. This module's job is to keep that fact
 * distinguishable from "ran on the thing you see", never to invent a value.
 */

/** The execution target a conversation recorded, if it recorded one. */
export type ConversationExecutionTarget =
  | { kind: "environment"; environmentId: string }
  | { kind: "host"; hostId: string }
  /** Nothing on the row identifies where this conversation ran. */
  | { kind: "unrecorded" };

/** The target the composer is currently pointed at. */
export type ComposerExecutionTarget =
  | { kind: "environment"; environmentId: string }
  | { kind: "host"; hostId: string | null };

/**
 * The narrow slice of the session DTO this derivation reads. Structural on
 * purpose: the caller passes `ChatHistoryDetailSession`, and a test passes a
 * literal, without either having to import the other.
 */
export interface ConversationExecutionTargetSource {
  hostId?: string;
  resumeConfig?: { environmentId?: string };
}

function nonEmpty(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Read the recorded target off a persisted session.
 *
 * Environment wins over host when both are somehow present: an environment IS
 * the execution statement on the wire (`normalizeExecutionTarget` refuses a
 * body carrying both pointers), and a host id sitting beside it would be the
 * environment's resolved host, not an independent target.
 */
export function readConversationExecutionTarget(
  session: ConversationExecutionTargetSource | null | undefined,
): ConversationExecutionTarget {
  const environmentId = nonEmpty(session?.resumeConfig?.environmentId);
  if (environmentId) return { kind: "environment", environmentId };
  const hostId = nonEmpty(session?.hostId);
  if (hostId) return { kind: "host", hostId };
  return { kind: "unrecorded" };
}

/**
 * What the UI owes the user about the open conversation.
 *
 *   `none`       — the composer describes this conversation. Say nothing.
 *   `unrecorded` — the conversation never recorded a target, so the composer
 *                  cannot be describing it. The controls are the viewer's
 *                  current selection and must be labelled as such.
 *   `mismatch`   — the conversation DID record a target and it is not the one
 *                  selected. A reply would run somewhere else.
 */
export type ConversationTargetDisclosure =
  | { kind: "none" }
  | { kind: "unrecorded" }
  | {
      kind: "mismatch";
      recorded: Extract<
        ConversationExecutionTarget,
        { kind: "environment" } | { kind: "host" }
      >;
    };

/**
 * Compare the conversation's recorded target against the composer's.
 *
 * `recorded: null` means "no persisted conversation is open" — a live chat the
 * user started here, where the composer is the target by construction.
 */
export function describeConversationTargetDisclosure(input: {
  recorded: ConversationExecutionTarget | null;
  composer: ComposerExecutionTarget;
}): ConversationTargetDisclosure {
  const { recorded, composer } = input;
  if (!recorded) return { kind: "none" };
  if (recorded.kind === "unrecorded") return { kind: "unrecorded" };
  if (recorded.kind === "environment") {
    return composer.kind === "environment" &&
      composer.environmentId === recorded.environmentId
      ? { kind: "none" }
      : { kind: "mismatch", recorded };
  }
  return composer.kind === "host" && composer.hostId === recorded.hostId
    ? { kind: "none" }
    : { kind: "mismatch", recorded };
}
