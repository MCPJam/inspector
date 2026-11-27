import type {
  SwarmJourneyFinding,
  SwarmJourneyFindings,
} from "../../contract/swarm-finding.js";
import {
  describePlatformRefusal,
  formatPermalinkLines,
  isPlatformApiError,
  platformRefusalHint,
  type PlatformPermalink,
} from "../../platform/index.js";

// Carry a machine-readable error code into the widget so it can tell an empty
// state (NOT_FOUND: no accessible projects, or a selector that matched nothing)
// apart from a real failure (network, timeout, auth) and render the former
// calmly instead of with the alarming destructive styling. The model/CLI still
// see `isError` plus the human-readable text message.
export function errorStructuredContent(
  error: unknown
): Record<string, unknown> | undefined {
  if (isPlatformApiError(error)) {
    // A usage-limit refusal also carries WHEN to come back and whether credits
    // would help — allowlisted by `describePlatformRefusal`, never the raw
    // server envelope — so an agent can wait instead of looping or suggesting
    // a top-up that cannot lift it.
    const refusal = describePlatformRefusal(error);
    // A feature-gate refusal keeps its own code and the feature it names, so
    // an agent can tell FEATURE_UNAVAILABLE for one beta from any other 403.
    // Only these two keys: the rest of `details` is the server's envelope.
    const feature =
      typeof error.details?.feature === "string"
        ? error.details.feature
        : undefined;
    const detailCode = error.details?.code;
    const details =
      feature !== undefined || detailCode === "FEATURE_UNAVAILABLE"
        ? {
            ...(typeof detailCode === "string" ? { code: detailCode } : {}),
            ...(feature !== undefined ? { feature } : {}),
          }
        : {};
    return {
      error: {
        code: error.code,
        message: error.message,
        // The failing request's id, so a report of this failure can be joined
        // to the server's logs. Only responses carry one.
        ...(error.requestId ? { requestId: error.requestId } : {}),
        ...(refusal ? { refusal } : {}),
        ...(Object.keys(details).length > 0 ? { details } : {}),
      },
    };
  }
  return undefined;
}

export function describeOperationError(error: unknown): string {
  if (isPlatformApiError(error)) {
    // Wire errors keep their stable code for agent retry logic; synthesized
    // client-side errors (status 0) are already self-explanatory messages.
    const message =
      error.status > 0 ? `${error.code}: ${error.message}` : error.message;
    // In the text as well as `structuredContent`, for the same reason as the
    // retry guidance below: the text is the channel every host shows a model.
    const base = error.requestId
      ? `${message} (request id: ${error.requestId})`
      : message;
    // Hosts vary in whether the model sees `structuredContent`, so the retry
    // guidance is in the text too.
    const refusal = describePlatformRefusal(error);
    return [base, refusal ? platformRefusalHint(refusal) : undefined]
      .filter((part): part is string => part !== undefined)
      .join(" ");
  }
  return error instanceof Error ? error.message : String(error);
}

// Cap on the model-visible text rendering. Resource reads, tool schemas,
// and doctor reports are unbounded upstream; hosts feed `content` into model
// context, so an uncapped pretty-print can blow a turn's budget. Mirrors the
// inspector workspace built-ins' MODEL_OUTPUT_CAP philosophy (never fail
// over size, degrade to a readable prefix). `structuredContent` stays
// complete — widgets and programmatic consumers read that, not the text.
export const MODEL_TEXT_CAP = 24_000;

// ── insights-envelope compaction ─────────────────────────────────────────────
// Runs BEFORE both renderings (text AND structuredContent): the generic text
// cap is a blind character slice, and an insights envelope sliced mid-JSON
// would read as complete while silently missing findings. This compaction is
// deterministic and self-describing — every omission lands in the envelope's
// own `truncation` counters, so a reader can never mistake a compacted
// response for a complete one.
export const MODEL_MAX_FINDINGS = 8;
export const MODEL_MAX_EVIDENCE_PER_FINDING = 2;
export const MODEL_CONTRACT_JSON_CAP = 600;

type EnvelopeLike = {
  journeyFindings?: SwarmJourneyFindings | null;
  schemaVersion: number;
  findings: Array<Record<string, unknown>>;
  truncation: {
    truncated: boolean;
    omittedFindings: number;
    omittedEvidence: number;
    contractTruncated: boolean;
  };
};

function isInsightsEnvelope(value: unknown): value is EnvelopeLike {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as EnvelopeLike;
  // `typeof null === "object"`, so the truncation check must reject null
  // explicitly: a payload with `truncation: null` would otherwise pass as an
  // envelope and throw while compaction read its counters, turning one
  // malformed field into a failed tool call.
  return (
    candidate.schemaVersion === 1 &&
    Array.isArray(candidate.findings) &&
    typeof candidate.truncation === "object" &&
    candidate.truncation !== null
  );
}

export const MODEL_MAX_SESSION_IDS_PER_FINDING = 5;
export const MODEL_EXCERPT_CAP = 400;
export const MODEL_PHRASE_CAP = 240;

/**
 * Cut `text` to at most `cap` characters, ellipsis included, preferring the
 * last word boundary. Text with no space to cut at is hard-cut rather than
 * collapsed to a bare ellipsis.
 */
export function clampAtWord(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const head = text.slice(0, cap - 1);
  const space = head.lastIndexOf(" ");
  return (space > 0 ? head.slice(0, space) : head).trimEnd() + "…";
}

const JOURNEY_BASIS_RANK: Record<SwarmJourneyFinding["basis"], number> = {
  verifiedMechanism: 0,
  populationFact: 1,
  sessionReport: 2,
};

/**
 * Compact a swarm run's `journeyFindings` the way {@link compactEnvelope}
 * compacts the envelope's own findings: verified mechanisms first, a head
 * slice, evidence capped per finding, model phrases clamped. Personas and
 * populations are never touched: they are the counts every sentence rests on.
 */
export function compactJourneyFindings(value: SwarmJourneyFindings) {
  let omittedEvidence = 0;
  let contractTruncated = false;
  const clampPhrase = (phrase: string | null, cap: number) => {
    if (phrase === null || phrase.length <= cap) return phrase;
    contractTruncated = true;
    return clampAtWord(phrase, cap);
  };
  const findings = [...value.findings]
    .sort((a, b) => JOURNEY_BASIS_RANK[a.basis] - JOURNEY_BASIS_RANK[b.basis])
    .slice(0, MODEL_MAX_FINDINGS)
    .map((finding) => {
      omittedEvidence += Math.max(
        0,
        finding.citations.length - MODEL_MAX_EVIDENCE_PER_FINDING
      );
      omittedEvidence += Math.max(
        0,
        finding.sessionIds.length - MODEL_MAX_SESSION_IDS_PER_FINDING
      );
      let reportExcerpt = finding.reportExcerpt;
      if (reportExcerpt) {
        omittedEvidence += Math.max(
          0,
          reportExcerpt.citations.length - MODEL_MAX_EVIDENCE_PER_FINDING
        );
        reportExcerpt = {
          actual: clampPhrase(reportExcerpt.actual, MODEL_EXCERPT_CAP)!,
          // This object is REBUILT rather than spread, so a field left out
          // here is silently dropped from everything the model reads.
          ...(reportExcerpt.account
            ? {
                account: clampPhrase(reportExcerpt.account, MODEL_EXCERPT_CAP)!,
              }
            : {}),
          citations: reportExcerpt.citations.slice(
            0,
            MODEL_MAX_EVIDENCE_PER_FINDING
          ),
        };
      }
      return {
        ...finding,
        sessionIds: finding.sessionIds.slice(
          0,
          MODEL_MAX_SESSION_IDS_PER_FINDING
        ),
        citations: finding.citations.slice(0, MODEL_MAX_EVIDENCE_PER_FINDING),
        outcomePhrase: clampPhrase(finding.outcomePhrase, MODEL_PHRASE_CAP),
        mechanismPhrase: clampPhrase(finding.mechanismPhrase, MODEL_PHRASE_CAP),
        fixPhrase: clampPhrase(finding.fixPhrase, MODEL_PHRASE_CAP),
        reportExcerpt,
      };
    });
  const omittedFindings = value.findings.length - findings.length;
  return {
    value: { ...value, findings },
    omittedFindings,
    omittedEvidence,
    contractTruncated,
  };
}

/**
 * An eval run's finished findings analysis lists its findings twice: in
 * `findings`, which every client reads, and in `currentFindings`. Sending both
 * spends the model's context on a copy, so the copy is dropped and the drop is
 * stated, so a reader does not take the missing field for missing findings.
 *
 * Only when `findings` fits under the cap: past it, compaction keeps the
 * first MODEL_MAX_FINDINGS, and `currentFindings` is then the only place the
 * rest are.
 */
function dropRepeatedCurrentFindings(envelope: EnvelopeLike): EnvelopeLike {
  const current = (envelope as { currentFindings?: unknown }).currentFindings;
  if (
    !Array.isArray(current) ||
    current.length === 0 ||
    current.length !== envelope.findings.length ||
    current.length > MODEL_MAX_FINDINGS
  ) {
    return envelope;
  }
  // Whole rows, not ids: a legacy result and the findings snapshot can name
  // the same finding id with different prose. Both lists come from one JSON
  // response, so equal rows serialize identically.
  const repeated = current.every(
    (row, i) => JSON.stringify(row) === JSON.stringify(envelope.findings[i])
  );
  if (!repeated) return envelope;
  const next: Record<string, unknown> = {
    ...envelope,
    currentFindingsSameAsFindings: true,
  };
  delete next.currentFindings;
  return next as EnvelopeLike;
}

function compactEnvelope(source: EnvelopeLike): EnvelopeLike {
  const envelope = dropRepeatedCurrentFindings(source);
  const journey = envelope.journeyFindings
    ? compactJourneyFindings(envelope.journeyFindings)
    : null;
  let omittedEvidence = journey?.omittedEvidence ?? 0;
  let contractTruncated = journey?.contractTruncated ?? false;
  // Findings arrive ready-first from the producer, so a head slice keeps
  // every server-ready finding before any investigation is dropped.
  const kept = envelope.findings.slice(0, MODEL_MAX_FINDINGS).map((finding) => {
    const next = { ...finding };
    const evidence = Array.isArray(finding.evidence)
      ? (finding.evidence as unknown[])
      : [];
    if (evidence.length > MODEL_MAX_EVIDENCE_PER_FINDING) {
      omittedEvidence += evidence.length - MODEL_MAX_EVIDENCE_PER_FINDING;
      next.evidence = evidence.slice(0, MODEL_MAX_EVIDENCE_PER_FINDING);
    }
    const target = finding.target as
      { currentDefinition?: Record<string, unknown> } | undefined;
    const def = target?.currentDefinition;
    if (def) {
      const clipped = { ...def };
      for (const key of ["inputSchemaJson", "outputSchemaJson"] as const) {
        const json = clipped[key];
        if (typeof json === "string" && json.length > MODEL_CONTRACT_JSON_CAP) {
          clipped[key] = json.slice(0, MODEL_CONTRACT_JSON_CAP);
          clipped.truncated = true;
          contractTruncated = true;
        }
      }
      next.target = { ...target, currentDefinition: clipped };
    }
    return next;
  });
  const omittedFindings =
    envelope.findings.length - kept.length + (journey?.omittedFindings ?? 0);
  if (omittedFindings === 0 && omittedEvidence === 0 && !contractTruncated) {
    return envelope;
  }
  return {
    ...envelope,
    findings: kept,
    ...(journey ? { journeyFindings: journey.value } : {}),
    truncation: {
      truncated: true,
      omittedFindings: envelope.truncation.omittedFindings + omittedFindings,
      omittedEvidence: envelope.truncation.omittedEvidence + omittedEvidence,
      contractTruncated:
        envelope.truncation.contractTruncated || contractTruncated,
    },
  };
}

/** Compact every insights envelope found at the payload's top level or one
 * level down (`{ run: { insights } }`, `{ scenario: { insights } }`). */
export function compactInsightsForModel<T extends object>(payload: T): T {
  let changed = false;
  const out: Record<string, unknown> = {
    ...(payload as Record<string, unknown>),
  };
  for (const [key, value] of Object.entries(out)) {
    if (isInsightsEnvelope(value)) {
      const compacted = compactEnvelope(value);
      if (compacted !== value) {
        out[key] = compacted;
        changed = true;
      }
      continue;
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const inner = value as Record<string, unknown>;
      if (isInsightsEnvelope(inner.insights)) {
        const compacted = compactEnvelope(inner.insights);
        if (compacted !== inner.insights) {
          out[key] = { ...inner, insights: compacted };
          changed = true;
        }
      }
    }
  }
  return changed ? (out as T) : payload;
}

/**
 * @param permalinks Rendered as ONE concise line each, above the JSON.
 *
 * Duplicated deliberately, and only here: hosts vary in whether they render
 * `structuredContent` at all, so a permalink that existed only there would be
 * invisible in some clients — and the model is meant to see it and hand it to
 * the user verbatim. The lines lead so they survive the truncation below,
 * which is exactly what a large list result would otherwise cut. The JSON
 * itself is NOT re-scanned for permalinks: the array inside it is the same
 * data, and printing both twice would spend the model's budget on URLs.
 */
export function toolSuccess(
  payload: object,
  permalinks: PlatformPermalink[] = []
) {
  payload = compactInsightsForModel(payload);
  const header = permalinks.length
    ? `${formatPermalinkLines(permalinks)}\n\n`
    : "";
  let text = `${header}${JSON.stringify(payload, null, 2)}`;
  if (text.length > MODEL_TEXT_CAP) {
    text = `${text.slice(0, MODEL_TEXT_CAP)}\n…[truncated ${
      text.length - MODEL_TEXT_CAP
    } chars; the complete payload is in structuredContent]`;
  }
  return {
    content: [
      {
        type: "text" as const,
        text,
      },
    ],
    structuredContent: payload as Record<string, unknown>,
  };
}

export function toolError(
  message: string,
  structuredContent?: Record<string, unknown>
) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}
