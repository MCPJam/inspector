import { describe, expect, it } from "vitest";
import {
  buildConformanceProfileStamp,
  conformanceProfile,
  conformanceProfileDigest,
  partitionByProfile,
  partitionByStamp,
  unscoredCheckIds,
  CONFORMANCE_CHECKER_VERSION,
  type ConformanceProfile,
} from "../src/conformance-profile.js";
import { computeConformanceScore } from "../src/conformance-score.js";
import { MCP_CHECK_IDS } from "../src/mcp-conformance/types.js";
import { MCP_TASKS_CHECK_IDS } from "../src/tasks-conformance/types.js";
import type { OutcomeCheckLike } from "../src/conformance-outcome.js";

const PROFILE = conformanceProfile("mcp-protocol");

function passed(id: string): OutcomeCheckLike {
  return { id, status: "passed" };
}
function failed(id: string): OutcomeCheckLike {
  return { id, status: "failed", error: { message: "boom" } };
}

describe("conformance profile manifest", () => {
  it("names only check ids the inventory can actually produce", () => {
    // A manifest entry for a deleted check would silently shrink the
    // denominator for every server, forever.
    const inventory = new Set<string>(MCP_CHECK_IDS);
    const unknown = PROFILE.scored.filter((id) => !inventory.has(id));
    expect(unknown).toEqual([]);
  });

  it("scores exactly the 36-check pool it was frozen at", () => {
    // The profile is FROZEN at the pre-gap-program pool on purpose. Adding a
    // check without a profile bump keeps this green (the check lands pending,
    // which is the intent); silently PROMOTING one moves the count and fails.
    expect(PROFILE.scored).toHaveLength(36);
  });

  it("states exactly which shipped checks it leaves unscored", () => {
    // The reviewable record. Every id here ran against real servers and
    // reported a real verdict this profile version chose not to grade yet;
    // promoting one is a version bump, and this list is where that shows up.
    expect([...unscoredCheckIds(PROFILE)].sort()).toEqual([
      "modern-cache-hint-coverage",
      "modern-cache-hint-values-valid",
      "modern-cache-scope-stable-across-pages",
      "modern-header-names-case-insensitive",
      "modern-missing-method-header-rejected",
      "modern-resource-read-no-empty-contents",
      "modern-tool-output-schema-conformant",
      "wire-schema-valid",
    ]);
  });

  it("has no duplicate entries", () => {
    expect(new Set(PROFILE.scored).size).toBe(PROFILE.scored.length);
  });

  it("digests membership, not authoring order", () => {
    const reordered: ConformanceProfile = {
      ...PROFILE,
      scored: [...PROFILE.scored].reverse(),
    };
    expect(conformanceProfileDigest(reordered)).toBe(
      conformanceProfileDigest(PROFILE),
    );
  });

  it("digests differ when the scored set differs, same id and version", () => {
    // The whole point of the digest: an edited manifest that forgot its
    // version bump is detectable. The cache must not paper over it, which is
    // why it is keyed on the object rather than the id.
    const edited: ConformanceProfile = {
      id: PROFILE.id,
      version: PROFILE.version,
      scored: PROFILE.scored.slice(1),
    };
    expect(conformanceProfileDigest(edited)).not.toBe(
      conformanceProfileDigest(PROFILE),
    );
  });
});

describe("the mcp-tasks profile", () => {
  const TASKS = conformanceProfile("mcp-tasks");

  it("is a separate profile, not a section of mcp-protocol", () => {
    // The design decision this encodes: folding tasks into the protocol
    // manifest would make a tasks addition bump the protocol denominator, so a
    // server that never implemented the extension would see its protocol
    // score's meaning change because we learned something about tasks.
    expect(TASKS.id).toBe("mcp-tasks");
    expect(TASKS.id).not.toBe(PROFILE.id);
    expect(conformanceProfileDigest(TASKS)).not.toBe(
      conformanceProfileDigest(PROFILE),
    );
  });

  it("names only tasks check ids the inventory can produce", () => {
    const inventory = new Set<string>(MCP_TASKS_CHECK_IDS);
    expect(TASKS.scored.filter((id) => !inventory.has(id))).toEqual([]);
  });

  it("states exactly which shipped tasks checks it leaves unscored", () => {
    expect([...unscoredCheckIds(TASKS)].sort()).toEqual([
      "tasks-cancel-ack-shape",
      "tasks-input-required-update-completes",
      "tasks-invalid-task-id-rejected",
      "tasks-status-payload-shape",
      "tasks-ttl-integer-shape",
      "tasks-undeclared-capability-names-requirements",
    ]);
  });
});

describe("profile stamp", () => {
  it("lists the reported checks the profile does not score, sorted", () => {
    const stamp = buildConformanceProfileStamp({
      profile: PROFILE,
      checks: [
        passed("ping"),
        passed("wire-schema-valid"),
        passed("modern-missing-method-header-rejected"),
      ],
      protocolVersion: "2026-07-28",
    });
    expect(stamp.pendingCheckIds).toEqual([
      "modern-missing-method-header-rejected",
      "wire-schema-valid",
    ]);
    expect(stamp.profileId).toBe("mcp-protocol");
    expect(stamp.profileVersion).toBe(PROFILE.version);
    expect(stamp.manifestDigest).toBe(conformanceProfileDigest(PROFILE));
    expect(stamp.checkerVersion).toBe(CONFORMANCE_CHECKER_VERSION);
    expect(stamp.protocolVersion).toBe("2026-07-28");
  });

  it("omits optional identity fields it was not given", () => {
    const stamp = buildConformanceProfileStamp({
      profile: PROFILE,
      checks: [passed("ping")],
    });
    expect(stamp.pendingCheckIds).toEqual([]);
    expect("protocolVersion" in stamp).toBe(false);
    expect("schemaDigest" in stamp).toBe(false);
    expect("extensionVersions" in stamp).toBe(false);
  });

  it("carries the schema digest and extension versions when supplied", () => {
    const stamp = buildConformanceProfileStamp({
      profile: PROFILE,
      checks: [passed("ping")],
      schemaDigest: "deadbeef",
      extensionVersions: { "io.modelcontextprotocol/tasks": "draft" },
    });
    expect(stamp.schemaDigest).toBe("deadbeef");
    expect(stamp.extensionVersions).toEqual({
      "io.modelcontextprotocol/tasks": "draft",
    });
  });
});

describe("partitioning", () => {
  it("splits by manifest membership at write time", () => {
    const { scored, pending } = partitionByProfile(
      [passed("ping"), passed("brand-new-check")],
      PROFILE,
    );
    expect(scored.map((c) => c.id)).toEqual(["ping"]);
    expect(pending.map((c) => c.id)).toEqual(["brand-new-check"]);
  });

  it("reproduces the same split from the stamp alone at read time", () => {
    const checks = [passed("ping"), failed("brand-new-check")];
    const stamp = buildConformanceProfileStamp({ profile: PROFILE, checks });
    const { scored, pending } = partitionByStamp(checks, stamp);
    expect(scored.map((c) => c.id)).toEqual(["ping"]);
    expect(pending.map((c) => c.id)).toEqual(["brand-new-check"]);
  });

  it("scores everything when there is no stamp", () => {
    const checks = [passed("ping"), passed("brand-new-check")];
    const { scored, pending } = partitionByStamp(checks, undefined);
    expect(scored).toHaveLength(2);
    expect(pending).toHaveLength(0);
  });
});

describe("pending checks and the score", () => {
  it("keeps a failing pending check out of the verdict and the denominator", () => {
    const checks = [passed("ping"), passed("tools-list"), failed("wire-schema-valid")];
    const stamp = buildConformanceProfileStamp({ profile: PROFILE, checks });

    const scored = computeConformanceScore(checks, [], "2026-07-28", stamp);
    expect(scored.outcome).toBe("passed");
    expect(scored.applicable).toBe(2);
    expect(scored.passed).toBe(2);
    expect(scored.failed).toBe(0);
    expect(scored.pending).toBe(1);
    expect(scored.score).toBe(100);

    // The same checks WITHOUT a profile fail the run — which is exactly what
    // the pending bucket exists to defer.
    const unstamped = computeConformanceScore(checks, [], "2026-07-28");
    expect(unstamped.outcome).toBe("failed");
    expect(unstamped.pending).toBe(0);
  });

  it("reports zero pending for a suite with no profile", () => {
    expect(computeConformanceScore([passed("a")]).pending).toBe(0);
  });
});
