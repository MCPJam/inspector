import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalizeHostConfigV2,
  computeHostConfigHashV2,
  sha256Hex,
} from "../src/host-config/internal";
import type { HostConfigInputV2 } from "../src/host-config/internal";

/**
 * Golden-vector parity fixture. The Convex backend keeps a BYTE-IDENTICAL copy
 * and runs its own (hand-mirrored) canonicalizer against it. If either
 * canonicalizer drifts, that repo's copy of this test fails because the
 * canonical JSON / sha256 no longer matches the pinned golden values.
 *
 * `EXPECTED_INPUT_HASH` is the sha256 of the fixture's `rows` array. Bump it
 * whenever you regenerate the fixture (scripts/gen-host-config-parity-fixture.mjs)
 * so the drift guard fails loudly on a stale copy.
 *
 * The backend used to mirror this fixture + constant for cross-repo parity,
 * but Stage 1 (mcpjam-backend PR #409) collapsed that into a one-import
 * delegation — the backend's canonicalize tests now exercise the SDK
 * directly, so the SDK-side constant is the single source of truth.
 */
const EXPECTED_INPUT_HASH =
  "32a8406b9ff8d090c2ba3e0c2f4093c3af06e9a54fb6f5913c24e72458ca29c4";

type FixtureRow = {
  label: string;
  input: HostConfigInputV2;
  canonicalJson: string;
  sha256: string;
};
type Fixture = { __inputHash: string; rows: FixtureRow[] };

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(
    join(here, "fixtures", "host-config-parity-fixtures.json"),
    "utf8",
  ),
) as Fixture;

describe("hostConfig v2 golden-vector parity", () => {
  it("fixture self-hash matches the pinned constant (drift guard)", async () => {
    expect(fixture.__inputHash).toBe(EXPECTED_INPUT_HASH);
    const recomputed = await sha256Hex(JSON.stringify(fixture.rows));
    expect(recomputed).toBe(EXPECTED_INPUT_HASH);
  });

  it("ships a non-trivial battery of vectors", () => {
    expect(fixture.rows.length).toBeGreaterThanOrEqual(10);
  });

  for (const row of fixture.rows) {
    it(`canonicalizes "${row.label}" to the golden canonical JSON`, () => {
      expect(JSON.stringify(canonicalizeHostConfigV2(row.input))).toBe(
        row.canonicalJson,
      );
    });

    it(`hashes "${row.label}" to the golden sha256`, async () => {
      expect(await computeHostConfigHashV2(row.input)).toBe(row.sha256);
    });
  }

  it("never persists a `deny` field (allowlist-only invariant)", () => {
    // The adversarial vector feeds stray csp.deny + permissions.deny. The
    // persisted host-config shape is allowlist-only, so they must be dropped.
    // Guards against accidentally reusing the runtime resolver's
    // deny-bearing policy types (sandbox-policy.ts) in the canonical shape.
    const adversarial = fixture.rows.find((r) =>
      r.label.includes("adversarial-stray-deny"),
    );
    expect(adversarial).toBeDefined();
    expect(adversarial!.canonicalJson).not.toContain("deny");
    expect(
      JSON.stringify(canonicalizeHostConfigV2(adversarial!.input)),
    ).not.toContain("deny");
  });
});
