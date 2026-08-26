/**
 * Claimed wire data → the SDK adapter's input.
 *
 * PURE, and separate from the pass for the same reason `stage-inputs.ts` is
 * separate from `finalize-iteration.ts`: normalization is where a chat surface
 * differs, and it is the only part worth testing exhaustively against hostile
 * wire data.
 *
 * Everything crossing this boundary is UNTRUSTED SHAPE. It is server-derived
 * data (the backend read it from the session row), but it arrives over HTTP as
 * JSON with no schema, and the failure mode of guessing is not a crash — it is
 * a chain that reads green off a field that was never there. So every read is
 * a narrowing read, and a field that does not narrow is ABSENT rather than
 * defaulted: absent evidence derives `notMeasured`, a defaulted zero derives a
 * verdict.
 */

import type {
  ChatSessionCriteriaEvidence,
  ChatSessionGoalJudgeEvidence,
  ChatSessionLifecycle,
  ChatSessionReadinessEvidence,
  ChatSessionStageInput,
  ChatSessionStageSource,
  StageSpanLike,
} from "@mcpjam/sdk/contract";
import { CHAT_SESSION_STAGE_SOURCES } from "@mcpjam/sdk/contract";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export function normalizeStageSource(
  value: unknown,
): ChatSessionStageSource | null {
  return (CHAT_SESSION_STAGE_SOURCES as readonly unknown[]).includes(value)
    ? (value as ChatSessionStageSource)
    : null;
}

export function normalizeLifecycle(value: unknown): ChatSessionLifecycle {
  // `settled` is the conservative default: `running` would understate what a
  // finished transcript measured, and `stopped` would blank a chain that has
  // real evidence in it.
  return value === "running" || value === "stopped" ? value : "settled";
}

/**
 * A user ask exists when a user turn carries text.
 *
 * Read from the TRANSCRIPT, not from the session row's `firstMessagePreview`:
 * that field falls back to a non-user message when no user message exists, so
 * a non-empty preview does not prove someone asked for anything. `hasUserAsk`
 * decides whether `userValue` is `notMeasured` or `notApplicable`, and those
 * are two different claims about a real person.
 */
export function transcriptHasUserAsk(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => {
    if (!isRecord(message)) return false;
    if (message.role !== "user") return false;
    return messageCarriesText(message.content);
  });
}

function messageCarriesText(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (Array.isArray(content)) return content.some(messageCarriesText);
  if (isRecord(content)) {
    if (typeof content.text === "string") return content.text.trim().length > 0;
    return messageCarriesText(content.content);
  }
  return false;
}

/**
 * Trace spans, narrowed to what the analyzer reads.
 *
 * Only the six fields `StageSpanLike` declares survive. Everything else on a
 * normalized span — timings, token counts, `finishReason` (advisory display
 * only, and explicitly never a gate) — is dropped here rather than passed
 * through, so no future analyzer change can start reading a field this
 * boundary never meant to supply.
 */
export function normalizeSpans(spans: unknown): StageSpanLike[] {
  if (!Array.isArray(spans)) return [];
  const normalized: StageSpanLike[] = [];
  for (const span of spans) {
    if (!isRecord(span)) continue;
    const entry: StageSpanLike = {};
    const id = nonEmptyString(span.id);
    if (id) entry.id = id;
    const category = nonEmptyString(span.category);
    if (category) entry.category = category;
    const status = nonEmptyString(span.status);
    if (status) entry.status = status;
    const toolName = nonEmptyString(span.toolName);
    if (toolName) entry.toolName = toolName;
    const promptIndex = finiteNumber(span.promptIndex);
    if (promptIndex !== undefined) entry.promptIndex = promptIndex;
    const mcpErrorCode = finiteNumber(span.mcpErrorCode);
    if (mcpErrorCode !== undefined) entry.mcpErrorCode = mcpErrorCode;
    normalized.push(entry);
  }
  return normalized;
}

const READINESS_STATUSES = ["pending", "completed", "partial", "failed"];

export function normalizeReadiness(
  value: unknown,
): ChatSessionReadinessEvidence | undefined {
  if (!isRecord(value)) return undefined;
  if (!READINESS_STATUSES.includes(value.status as string)) return undefined;
  const advertisedToolsKnown = value.advertisedToolsKnown === true;
  return {
    status: value.status as ChatSessionReadinessEvidence["status"],
    ...(finiteNumber(value.toolCallCount) !== undefined
      ? { toolCallCount: finiteNumber(value.toolCallCount) }
      : {}),
    // The count only travels alongside the flag that says it means anything.
    // A count without `advertisedToolsKnown` is "we did not look", and
    // forwarding it alone would let the adapter read it as "there were none".
    ...(advertisedToolsKnown
      ? {
          advertisedToolsKnown: true,
          ...(finiteNumber(value.advertisedToolCount) !== undefined
            ? { advertisedToolCount: finiteNumber(value.advertisedToolCount) }
            : {}),
        }
      : {}),
  };
}

const CRITERIA_STATUSES = ["pending", "completed", "failed"];

export function normalizeCriteria(
  value: unknown,
): ChatSessionCriteriaEvidence | undefined {
  if (!isRecord(value)) return undefined;
  if (!CRITERIA_STATUSES.includes(value.status as string)) return undefined;
  const status = value.status as ChatSessionCriteriaEvidence["status"];
  if (status !== "completed") return { status };
  if (!Array.isArray(value.results)) {
    // `completed` with unreadable results is not a pass. Reporting it as a
    // completed grade with an empty rubric would let the adapter treat the
    // silence as "nothing to grade" instead of "we cannot read the grade".
    return { status: "pending" };
  }

  // The SCOPE the grade was claimed against. It is the only thing that makes
  // an empty `results` legible, so it is carried rather than dropped.
  const criterionIds = Array.isArray(value.criterionIds)
    ? value.criterionIds.flatMap((id) => {
        const trimmed = nonEmptyString(id);
        return trimmed ? [trimmed] : [];
      })
    : undefined;
  const scopeReadable =
    !Array.isArray(value.criterionIds) ||
    criterionIds!.length === value.criterionIds.length;

  const results = value.results.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const criterionId = nonEmptyString(entry.criterionId);
    if (!criterionId || typeof entry.passed !== "boolean") return [];
    return [{ criterionId, passed: entry.passed }];
  });

  // A row we could not read is a row we do not have. Reporting the survivors
  // as a complete grade would understate the rubric, and — when every row
  // drops — would hand `userValue` to the goal judge on a session the rubric
  // was supposed to answer.
  const droppedRows = results.length !== value.results.length;

  // `completed` means the grade covers its scope. Anything less is still owed,
  // so it reads as `pending`: honest, retryable, and re-derived the moment the
  // real grade lands, because the source stamp moves with it.
  const covered = new Set(results.map((row) => row.criterionId));
  const scopeCovered =
    criterionIds === undefined
      ? // No scope to check against. Rows present are self-evidencing; zero
        // rows with no scope is indistinguishable from a lost grade, and the
        // adapter refuses to let the judge fill that silence either way.
        results.length > 0
      : criterionIds.every((id) => covered.has(id));

  if (droppedRows || !scopeReadable || !scopeCovered) {
    return { status: "pending" };
  }

  return {
    status: "completed",
    results,
    ...(criterionIds !== undefined ? { criterionIds } : {}),
  };
}

const GOAL_STATUSES = ["running", "completed", "failed"];

export function normalizeGoalJudge(
  value: unknown,
): ChatSessionGoalJudgeEvidence | undefined {
  if (!isRecord(value)) return undefined;
  if (!GOAL_STATUSES.includes(value.status as string)) return undefined;
  const status = value.status as ChatSessionGoalJudgeEvidence["status"];
  return {
    status,
    // `passed` only travels on a completed verdict, and only when it is
    // actually a boolean: a `completed` judge with no verdict is silence,
    // which the adapter reports as unmeasured rather than as a fail.
    ...(status === "completed" && typeof value.passed === "boolean"
      ? { passed: value.passed }
      : {}),
    ...(nonEmptyString(value.reason) ? { reason: value.reason as string } : {}),
  };
}

export type NormalizeResult =
  | { ok: true; input: ChatSessionStageInput }
  /** The claim carried nothing derivable. Reported, never guessed around. */
  | { ok: false; errorCode: "evidence_unavailable" };

/**
 * Build the adapter input for one claimed session.
 *
 * Fails rather than deriving when the transcript envelope is unreadable. A
 * derivation built on an absent envelope would be six `notMeasured` rows that
 * look exactly like a session that genuinely captured nothing, and an
 * operator cannot tell those apart. `evidence_unavailable` can be retried;
 * a fabricated blank chain cannot be un-published.
 */
export function normalizeClaimedEvidence(claim: {
  source: string;
  evidence: {
    lifecycle?: unknown;
    readiness?: unknown;
    criteria?: unknown;
    goalScore?: unknown;
  };
  envelope: { messages?: unknown[]; spans?: unknown[] } | null;
}): NormalizeResult {
  const source = normalizeStageSource(claim.source);
  if (!source) return { ok: false, errorCode: "evidence_unavailable" };
  const envelope = claim.envelope;
  if (!envelope || !Array.isArray(envelope.messages)) {
    return { ok: false, errorCode: "evidence_unavailable" };
  }

  const spans = normalizeSpans(envelope.spans);
  const readiness = normalizeReadiness(claim.evidence.readiness);
  const criteria = normalizeCriteria(claim.evidence.criteria);
  const goalJudge = normalizeGoalJudge(claim.evidence.goalScore);

  return {
    ok: true,
    input: {
      source,
      hasUserAsk: transcriptHasUserAsk(envelope.messages),
      lifecycle: normalizeLifecycle(claim.evidence.lifecycle),
      ...(spans.length > 0 ? { spans } : {}),
      ...(readiness ? { readiness } : {}),
      ...(criteria ? { criteria } : {}),
      ...(goalJudge ? { goalJudge } : {}),
    },
  };
}
