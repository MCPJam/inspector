/**
 * The committed revocation list and the script that maintains it: what the
 * signing workflow signs is a list the Inspector's reader will accept, and a
 * revocation only ever moves the sequence forward.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// eslint-disable-next-line import/extensions -- plain ESM script with a hand-written .d.mts
import {
  addRevocation,
  REVOCATION_SCHEMA as SCRIPT_SCHEMA,
  REVOCATIONS_FILE,
  renderRevocationList,
  revocationListProblems,
} from "../../../../../scripts/local-harness-revocations.mjs";
import { DEFAULT_REVOCATIONS_URL, REVOCATION_SCHEMA, revocationFor } from "../runtime-revocation.js";

const digest = `sha256:${"ab".repeat(32)}`;

describe("the revocation list", () => {
  it("is committed in the shape the Inspector reads, at the path it fetches", () => {
    const list = JSON.parse(readFileSync(REVOCATIONS_FILE, "utf8"));
    expect(revocationListProblems(list)).toEqual([]);
    expect(SCRIPT_SCHEMA).toBe(REVOCATION_SCHEMA);
    expect(DEFAULT_REVOCATIONS_URL.endsWith("mcpjam-inspector/local-harness-revocations/revocations.json")).toBe(true);
    expect(REVOCATIONS_FILE.endsWith("local-harness-revocations/revocations.json")).toBe(true);
  });

  it("adds an entry by moving the sequence forward, never duplicating one", () => {
    const empty = { schema: SCRIPT_SCHEMA, sequence: 3, issuedAt: "2026-10-01T00:00:00.000Z", revoked: [] };
    const once = addRevocation(empty, { harnessId: "codex", treeDigest: digest, reason: " crashes " }, new Date("2026-10-06T00:00:00Z"));
    expect(once).toEqual({
      schema: REVOCATION_SCHEMA,
      sequence: 4,
      issuedAt: "2026-10-06T00:00:00.000Z",
      revoked: [{ harnessId: "codex", treeDigest: digest, reason: "crashes" }],
    });
    const twice = addRevocation(once, { harnessId: "codex", treeDigest: digest, reason: "still crashes" });
    expect(twice.sequence).toBe(5);
    expect(twice.revoked).toHaveLength(1);
    expect(revocationFor(twice, "codex", digest)?.reason).toBe("still crashes");
    expect(revocationFor(twice, "claude-code", digest)).toBeNull();
    expect(renderRevocationList(twice).endsWith("\n")).toBe(true);
  });

  it("refuses malformed entries before anything is signed", () => {
    expect(revocationListProblems({ schema: REVOCATION_SCHEMA, sequence: -1, issuedAt: "x", revoked: [{ harnessId: "Codex", treeDigest: "sha1:x", reason: "" }] })).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/sequence/),
        expect.stringMatching(/issuedAt/),
        expect.stringMatching(/harnessId/),
        expect.stringMatching(/treeDigest/),
        expect.stringMatching(/reason/),
      ]),
    );
  });
});
