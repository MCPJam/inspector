/**
 * Adapting an apps-conformance result into OpenAI readiness evidence.
 *
 * The Anthropic twin of `claude-readiness/evidence-adapters`, sharing its
 * attribution guard and nothing else. What each publisher READS off a widget
 * differs — Anthropic derives a content domain from the connector URL, OpenAI
 * requires `_meta.ui.domain` to be present and unique and grades a CSP
 * allowlist — so the two adapters produce different evidence shapes from the
 * same source material, and a shared one would have to invent a union that
 * neither publisher's checks want.
 *
 * The rules that matter are the shared ones: an incompatible source degrades
 * to MISSING, never to a pass and never to a failure, and the source's
 * identity survives onto the finding that rests on it.
 *
 * Pure data reasoning. No transport.
 */

import type { OutcomeCheckLike } from "../conformance-outcome.js";
import {
  checkEvidenceReuse,
  conformanceRunIsComplete,
  type AttributableEvidenceSource,
  type EvidenceReuse,
  type EvidenceReuseExpectation,
} from "../directory-readiness/evidence-reuse.js";
import type {
  OpenAIAppsUiEvidence,
  OpenAIUiResourceEvidence,
} from "./checks/apps-ui.js";

/** The suite kind this adapter reads, as it appears in `derivedFrom`. */
export const OPENAI_APPS_EVIDENCE_KIND = "apps-conformance";

export interface AdaptableAppsConformanceResult {
  target: string;
  /** Carried for the citation, NOT consulted for completeness — see `checks`. */
  outcome: string;
  /**
   * The run's checks, which are what say whether it finished. The outcome
   * cannot: `"failed"` is returned on the first violation without counting the
   * checks that never ran.
   */
  checks: readonly OutcomeCheckLike[];
}

export interface AdaptAppsResultToOpenAIOptions {
  result: AdaptableAppsConformanceResult;
  expectation: EvidenceReuseExpectation;
  runId?: string;
  configFingerprint?: string;
  /** The resource contents the suite run read, with their `_meta` intact. */
  resourceContents?: readonly {
    uri?: string;
    mimeType?: string;
    _meta?: unknown;
  }[];
  /** `uri` → tools that reference it, as the suite resolved them. */
  referencedByTools?: Record<string, string[]>;
  /** Screenshots the submission supplies, from the profile. */
  screenshotCount?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter(
    (entry): entry is string => typeof entry === "string",
  );
  return entries.length > 0 ? entries : undefined;
}

/**
 * Read the domains a resource's declared CSP names.
 *
 * TOLERANT ABOUT SHAPE, because the extension spells this two ways in the
 * wild: a flat array of domains, and an object of directive → domains. Reading
 * whichever is present costs nothing; insisting on one would report a template
 * with a perfectly good allowlist as declaring none, and the check that grades
 * "the allowlist is exact" would then flag every domain the template loads.
 */
function declaredCspDomains(csp: unknown): string[] | undefined {
  const flat = stringArray(csp);
  if (flat) return flat;
  const record = asRecord(csp);
  if (!record) return undefined;
  const domains = Object.values(record).flatMap(
    (value) => stringArray(value) ?? [],
  );
  return domains.length > 0 ? [...new Set(domains)].sort() : undefined;
}

/**
 * Adapt an apps-conformance result, or refuse with a reason.
 *
 * `observedDomains` and the two schema booleans are deliberately NOT filled
 * in. The apps suite does not render the template in a browser, so it never
 * observed which domains it loads; inventing an empty array here would let the
 * "the CSP allowlist is exact" check compare a declared allowlist against a
 * list nobody measured and report every declared domain as unnecessary.
 * Leaving them absent keeps those checks `not-evaluated`, which is what they
 * are.
 */
export function adaptAppsResultToOpenAIUiEvidence(
  options: AdaptAppsResultToOpenAIOptions,
): EvidenceReuse<OpenAIAppsUiEvidence> {
  const source: AttributableEvidenceSource = {
    kind: OPENAI_APPS_EVIDENCE_KIND,
    runId: options.runId,
    target: options.result.target,
    configFingerprint: options.configFingerprint,
    complete: conformanceRunIsComplete(options.result.checks),
  };

  const verdict = checkEvidenceReuse(source, options.expectation);
  if (!verdict.ok) return verdict;

  const resources: OpenAIUiResourceEvidence[] = (
    options.resourceContents ?? []
  ).flatMap((content) => {
    const uri = typeof content.uri === "string" ? content.uri : undefined;
    if (!uri) return [];
    const ui = asRecord(asRecord(content._meta)?.ui);
    return [
      {
        uri,
        mimeType: content.mimeType,
        domain: typeof ui?.domain === "string" ? ui.domain : undefined,
        declaredCspDomains: declaredCspDomains(ui?.csp),
        referencedByTools: options.referencedByTools?.[uri],
      },
    ];
  });

  return {
    ok: true,
    sourceRef: verdict.sourceRef,
    evidence: {
      resources,
      screenshotCount: options.screenshotCount,
    },
  };
}
