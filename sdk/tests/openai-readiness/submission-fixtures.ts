/**
 * Submission-profile fixtures.
 *
 * `completeSubmissionProfile` is the one a REAL submission would produce: every
 * required field present, the right number of each kind of test case, every
 * attestation affirmed. Tests derive failures from it by overriding one field,
 * so a test that fails names the single thing it changed rather than leaving a
 * reader to diff two long literals.
 *
 * Nothing here is a credential. The profile schema records that reviewer access
 * EXISTS and how it is delivered, never what it is, and a fixture carrying a
 * plausible-looking password would be the first step toward a schema that
 * accepted one.
 */

import type { OpenAISubmissionProfile } from "../../src/openai-readiness/submission-profile.js";
import { OPENAI_ATTESTATIONS } from "../../src/openai-readiness/submission-profile.js";
import { OPENAI_SUBMISSION_TEST_CASES } from "../../src/openai-readiness/profile.js";

function testCases(count: number, kind: string) {
  return Array.from({ length: count }, (_unused, index) => ({
    prompt: `${kind} prompt ${index + 1}`,
    expectation: `${kind} expectation ${index + 1}`,
  }));
}

export function completeSubmissionProfile(
  overrides: Partial<OpenAISubmissionProfile> = {},
): Record<string, unknown> {
  return {
    name: "Weather",
    shortDescription: "Forecasts for any city",
    description: "Look up forecasts, alerts and history for any city.",
    categories: ["productivity"],
    privacyPolicyUrl: "https://weather.example.com/privacy",
    supportUrl: "https://weather.example.com/support",
    testCases: {
      successful: testCases(
        OPENAI_SUBMISSION_TEST_CASES.successCount,
        "successful",
      ),
      gracefulFailure: testCases(
        OPENAI_SUBMISSION_TEST_CASES.failureCount,
        "failing",
      ),
    },
    demoCredentials: { provided: true, delivery: "in-submission-form" },
    demoRecordingProvided: true,
    screenshots: [],
    identityVerified: true,
    accountPermissions: ["api.apps.write"],
    availableCountries: ["US", "GB"],
    privacyPolicyDataTypes: ["account-identifiers"],
    annotationJustifications: {},
    frameDomainExplanations: {},
    domainVerificationToken: "token-placeholder-not-a-secret",
    lastScanAt: "2026-08-19T10:00:00.000Z",
    hasPublishedVersion: false,
    attestations: Object.fromEntries(
      OPENAI_ATTESTATIONS.map((attestation) => [attestation, true]),
    ),
    ...overrides,
  };
}
