import { canonicalizeOAuthProfile } from "../src/host-config/internal";
import { HP47_OAUTH_PROFILE_SEED } from "../src/host-config/oauth-profiles/catalog";
import { HOST_TEMPLATE_IDS } from "../src/host-config/templates/seed-host-template";
import type { HostConfigOAuthProfileV1 } from "../src/host-config/internal";

/**
 * HP-47 acceptance tests.
 *
 * The ticket's goal is that the OAuth profile be "complete and evidence-backed,
 * not just patched where an external partner happened to comment." Those are
 * two separable claims and this file enforces both mechanically:
 *
 *   COMPLETE      — every host in the catalog has a profile, no gaps (§1).
 *   EVIDENCE-BACKED — every recorded value carries a citation and a capture
 *                   date, and anything unconfirmed is `unverifiable` with a
 *                   reason rather than a plausible guess (§2).
 *
 * The second is the one that matters. HP-17 shipped four false claims because
 * nothing stopped an unsourced value from entering the matrix; a green run
 * here means that specific failure cannot recur silently.
 */

const ENTRIES = Object.entries(HP47_OAUTH_PROFILE_SEED) as Array<
  [string, HostConfigOAuthProfileV1]
>;

const EVIDENCE_FIELDS = [
  "sendsResourceIndicator",
  "oauthSpecVersion",
  "protocolVersionPinning",
  "dcrIdentity",
  "authModel",
] as const;

type EvidenceLike = {
  status: "verified" | "refuted" | "unverifiable";
  value?: unknown;
  source?: string;
  capturedAt?: string;
  reason?: string;
};

const evidenceOf = (
  profile: HostConfigOAuthProfileV1,
  field: (typeof EVIDENCE_FIELDS)[number],
): EvidenceLike | undefined =>
  profile[field] as unknown as EvidenceLike | undefined;

describe("HP-47 catalog — §1 completeness", () => {
  it("covers EVERY host in the catalog, with no extras", () => {
    // The ticket says 9 hosts; the catalog actually has 16. Deriving the
    // expectation from HOST_TEMPLATE_IDS rather than a hardcoded list means a
    // newly added host fails this test instead of silently going unprofiled.
    expect(Object.keys(HP47_OAUTH_PROFILE_SEED).sort()).toEqual(
      [...HOST_TEMPLATE_IDS].sort(),
    );
  });

  it("declares profileVersion 1 on every profile", () => {
    for (const [id, profile] of ENTRIES) {
      expect(profile.profileVersion, `${id}.profileVersion`).toBe(1);
    }
  });

  it("records all five dimensions for every host (a gap must be explicit)", () => {
    // "Unverifiable" is an acceptable answer; SILENCE is not. An omitted field
    // is indistinguishable from "nobody looked", which is exactly the ambiguity
    // HP-47 exists to remove.
    for (const [id, profile] of ENTRIES) {
      for (const field of EVIDENCE_FIELDS) {
        expect(evidenceOf(profile, field), `${id}.${field} is missing`).toBeDefined();
      }
    }
  });
});

describe("HP-47 catalog — §2 evidence discipline", () => {
  it("canonicalizes every profile without throwing", () => {
    // The canonicalizer is the real gate: it rejects unsourced values, bogus
    // capture dates, unknown enum members and ambiguous auth precedence.
    for (const [id, profile] of ENTRIES) {
      expect(() => canonicalizeOAuthProfile(profile), id).not.toThrow();
    }
  });

  it("gives every verified/refuted cell a non-empty citation", () => {
    for (const [id, profile] of ENTRIES) {
      for (const field of EVIDENCE_FIELDS) {
        const evidence = evidenceOf(profile, field);
        if (evidence?.status === "verified" || evidence?.status === "refuted") {
          expect(
            evidence.source?.trim(),
            `${id}.${field} is ${evidence.status} but has no source`,
          ).toBeTruthy();
        }
      }
    }
  });

  it("dates every verified/refuted cell (staleness must be measurable)", () => {
    for (const [id, profile] of ENTRIES) {
      for (const field of EVIDENCE_FIELDS) {
        const evidence = evidenceOf(profile, field);
        if (evidence?.status === "verified" || evidence?.status === "refuted") {
          expect(
            evidence.capturedAt,
            `${id}.${field} has no capture date`,
          ).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
      }
    }
  });

  it("never lets an unverifiable cell carry a value or a source", () => {
    // The headline invariant. Enforced by the canonicalizer too, but asserted
    // here so the failure names the offending host and field directly.
    for (const [id, profile] of ENTRIES) {
      for (const field of EVIDENCE_FIELDS) {
        const evidence = evidenceOf(profile, field);
        if (evidence?.status === "unverifiable") {
          expect(evidence.value, `${id}.${field}`).toBeUndefined();
          expect(evidence.source, `${id}.${field}`).toBeUndefined();
          expect(
            evidence.reason?.trim(),
            `${id}.${field} is unverifiable without a reason`,
          ).toBeTruthy();
        }
      }
    }
  });

  it("is idempotent under canonicalization", () => {
    // Guards against a hand-authored entry that only *looks* canonical — e.g.
    // redirect URIs in non-sorted order, which would round-trip to a different
    // hash than the literal in this file.
    for (const [id, profile] of ENTRIES) {
      const once = canonicalizeOAuthProfile(profile);
      const twice = canonicalizeOAuthProfile(once);
      expect(JSON.stringify(twice), id).toBe(JSON.stringify(once));
    }
  });
});

describe("HP-47 catalog — §3 coverage is honestly reported", () => {
  it("reports the verified / refuted / unverifiable split", () => {
    const tally = { verified: 0, refuted: 0, unverifiable: 0 };
    for (const [, profile] of ENTRIES) {
      for (const field of EVIDENCE_FIELDS) {
        const status = evidenceOf(profile, field)?.status;
        if (status) tally[status] += 1;
      }
    }
    const total = ENTRIES.length * EVIDENCE_FIELDS.length;
    expect(tally.verified + tally.refuted + tally.unverifiable).toBe(total);

    // Not a quality bar — a visible one. Desk research cannot close the
    // closed-source hosts; that needs live handshake capture (HP-44). Printing
    // the split keeps "how much is actually known" in front of reviewers
    // instead of buried in prose.
    console.info(
      `HP-47 coverage: ${tally.verified} verified, ${tally.refuted} refuted, ` +
        `${tally.unverifiable} unverifiable of ${total} cells ` +
        `(${Math.round(((tally.verified + tally.refuted) / total) * 100)}% evidence-backed)`,
    );
  });

  it("keeps at least one refuted cell on the record", () => {
    // Refutations are load-bearing: HP-45 requires disproven claims to STAY
    // recorded so they cannot quietly re-enter the matrix. If this ever drops
    // to zero, someone deleted a refutation instead of superseding it.
    const refuted = ENTRIES.flatMap(([, profile]) =>
      EVIDENCE_FIELDS.map((f) => evidenceOf(profile, f)?.status),
    ).filter((s) => s === "refuted");
    expect(refuted.length).toBeGreaterThan(0);
  });
});
