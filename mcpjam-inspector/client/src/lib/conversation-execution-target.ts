import {
  parseResumeExecutionTarget,
  type ResumeExecutionTarget,
} from "@/shared/execution-target";

/** Saved resume destination. Legacy rows remain explicitly unknown. */
/** The execution target a conversation recorded, if it recorded one. */
export type ConversationExecutionTarget =
  | ResumeExecutionTarget
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
  resumeConfig?: {
    environmentId?: string;
    executionTarget?: ResumeExecutionTarget;
  };
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
  const target = parseResumeExecutionTarget(
    session?.resumeConfig?.executionTarget,
  );
  if (target) return target;
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
        { kind: "environment" } | { kind: "host" } | { kind: "adhoc" }
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
  if (recorded.kind === "adhoc") {
    return composer.kind === "host" && composer.hostId === null
      ? { kind: "none" }
      : { kind: "mismatch", recorded };
  }
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
