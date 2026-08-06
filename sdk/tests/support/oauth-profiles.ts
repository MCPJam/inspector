/**
 * Evidence-envelope fixtures for the OAuth emulation suites.
 *
 * Shared so the three suites cannot drift on the envelope shape — a change to
 * what a valid `capturedAt` or `source` looks like should break one place, not
 * silently pass in two of three.
 */
import type { OAuthProfileEvidence } from "../../src/host-config/internal";

export const verified = <T,>(value: T): OAuthProfileEvidence<T> => ({
  status: "verified",
  value,
  source: "https://example.test/capture#L1",
  capturedAt: "2026-07-30",
});

/**
 * A refuted claim carries the TRUE value — the disproven part is the claim,
 * not the recording — so the emulator uses it exactly like a verified one.
 */
export const refuted = <T,>(value: T): OAuthProfileEvidence<T> => ({
  status: "refuted",
  value,
  source: "https://example.test/refutation#L1",
  capturedAt: "2026-07-30",
});

/** Carries no value, by construction. */
export const unverifiable = <T,>(): OAuthProfileEvidence<T> => ({
  status: "unverifiable",
  reason: "closed-source client",
});
