/**
 * The CLI's half of the eval-vocabulary negotiation
 * (`docs/evals-vocabulary-consolidation.md`, "The wire" and "Capability").
 *
 * A deployment ADVERTISES which vocabulary it understands
 * (`GET /capabilities` → `vocabulary.version`); a client never infers it. This
 * module asks once per command, derives a client that speaks what the
 * deployment advertised, and owns the two things that differ between the
 * vocabularies on the case and suite wire:
 *
 *   - the KEYS a body is written under ({@link CASE_WIRE_KEYS}), and
 *   - the KEYS a response is read under ({@link caseFromWire},
 *     {@link suiteDetailFromWire}).
 *
 * The CLI's internal case and suite model stays the SDK's vocabulary-1 type
 * (`PlatformEvalCase`, `PlatformEvalSuiteDetail`) for one more step: every
 * reader in `eval-suite-export.ts` and `eval-run-file.ts` spells the fields
 * that way, and re-spelling the model is a mechanical follow-up once
 * vocabulary 1 is contracted. So a vocabulary-2 response is projected onto
 * that model HERE — one projection, at the one boundary the wire crosses — and
 * nothing downstream branches on the vocabulary again.
 *
 * Against a deployment that predates the negotiation everything below is a
 * no-op: no `vocabulary` in the capability block means vocabulary 1, the
 * client is returned as is, and the bodies and readers are byte-for-byte what
 * they were.
 */

import {
  PlatformApiError,
  type PlatformApiClient,
  type PlatformEvalCase,
  type PlatformEvalCaseV2,
  type PlatformEvalSuiteDetail,
  type PlatformEvalSuiteDetailV2,
} from "@mcpjam/sdk/platform";

export type EvalVocabulary = 1 | 2;

/**
 * What each vocabulary calls the three case fields whose NAME depends on it.
 *
 * `floor` is the legacy per-case count the legacy resolver reads as
 * `max(floor, suite.minimumIterations)`; `exact` is the count a policy-2 case
 * runs; `rules` is the case's assertion override. One table, read by the body
 * builders and the response projection alike, so the two cannot disagree
 * about what a key means.
 */
export const CASE_WIRE_KEYS = {
  1: { floor: "iterations", exact: "repetitions", rules: "checks" },
  2: { floor: "legacyIterations", exact: "iterations", rules: "assertions" },
} as const satisfies Record<
  EvalVocabulary,
  { floor: string; exact: string; rules: string }
>;

export type NegotiatedEvalVocabulary = {
  vocabulary: EvalVocabulary;
  /**
   * A client that speaks `vocabulary`: the caller's own client under 1, a
   * sibling with the header under 2. Use it for every request the command
   * makes after the handshake — a read made with the other client would come
   * back in the other spelling.
   */
  client: PlatformApiClient;
};

/**
 * Ask the deployment which vocabulary it speaks, and hand back a client that
 * speaks it.
 *
 * The capability read is the ONLY thing that turns the header on. A
 * deployment without the `vocabulary` block — or without the capabilities
 * route at all, which a 404 says — is a vocabulary-1 deployment, and the
 * caller's client is returned untouched. Any other failure propagates: it is
 * an auth or network problem the command would hit on its next request
 * anyway, and swallowing it here would only move the error somewhere less
 * legible.
 */
export async function negotiateEvalVocabulary(
  client: PlatformApiClient,
  params: { projectId: string; signal?: AbortSignal }
): Promise<NegotiatedEvalVocabulary> {
  let advertised: number | undefined;
  try {
    const capabilities = await client.getCapabilities(
      { projectId: params.projectId },
      { signal: params.signal }
    );
    advertised = capabilities.vocabulary?.version;
  } catch (error) {
    if (error instanceof PlatformApiError && error.status === 404) {
      return { vocabulary: 1, client };
    }
    throw error;
  }
  if (advertised === 2) {
    return { vocabulary: 2, client: client.withEvalVocabulary(2) };
  }
  return { vocabulary: 1, client };
}

/**
 * A case as the wire returned it, under either vocabulary.
 *
 * The client's eval methods are typed for vocabulary 1; a client that speaks
 * 2 returns the V2 shape through the same signature. This union is what a
 * reader actually holds until {@link caseFromWire} settles it.
 */
export type WireEvalCase = PlatformEvalCase | PlatformEvalCaseV2;
export type WireEvalSuiteDetail =
  | PlatformEvalSuiteDetail
  | PlatformEvalSuiteDetailV2;

function renameKeys<T extends object>(
  value: T,
  renames: Readonly<Record<string, string>>
): Record<string, unknown> {
  // Positions preserved: a reader diffing two projections sees exactly the
  // renamed keys move, nothing else.
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[renames[key] ?? key] = entry;
  }
  return out;
}

/**
 * Settle a case the wire returned onto the CLI's internal (vocabulary-1)
 * model. Under 1 the row is returned as is — the same object, so today's
 * behaviour cannot drift. Under 2 the three renamed keys move back:
 * `legacyIterations` → `iterations`, `iterations` → `repetitions`,
 * `assertions` → `checks`.
 */
export function caseFromWire(
  vocabulary: EvalVocabulary,
  row: WireEvalCase
): PlatformEvalCase {
  if (vocabulary === 1) return row as PlatformEvalCase;
  const keys = CASE_WIRE_KEYS[2];
  const internal = CASE_WIRE_KEYS[1];
  return renameKeys(row, {
    [keys.floor]: internal.floor,
    [keys.exact]: internal.exact,
    [keys.rules]: internal.rules,
  }) as unknown as PlatformEvalCase;
}

/**
 * Settle a suite detail the wire returned onto the internal model: under 2,
 * `settings.defaultAssertions` → `settings.checks` and
 * `settings.verdictPolicyDefaults.iterations` → `.repetitions`.
 */
export function suiteDetailFromWire(
  vocabulary: EvalVocabulary,
  detail: WireEvalSuiteDetail
): PlatformEvalSuiteDetail {
  if (vocabulary === 1) return detail as PlatformEvalSuiteDetail;
  const v2 = detail as PlatformEvalSuiteDetailV2;
  const settings = renameKeys(v2.settings, { defaultAssertions: "checks" });
  if (v2.settings.verdictPolicyDefaults) {
    settings.verdictPolicyDefaults = renameKeys(
      v2.settings.verdictPolicyDefaults,
      { iterations: "repetitions" }
    );
  }
  return { ...v2, settings } as unknown as PlatformEvalSuiteDetail;
}
