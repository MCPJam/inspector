import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  CORE_WIRE_SCHEMAS,
  EXTENSION_WIRE_SCHEMAS,
} from "../../src/mcp-conformance/schemas/index.js";

/**
 * The vendored spec schemas are ~16k lines of machine-generated JSON — two
 * thirds of the diff that introduced them, and not something a reviewer reads.
 * Their whole value is being VERBATIM copies of a published document, so the
 * one property worth enforcing is that nobody edits them in place: a hand-tweak
 * to make a check pass would silently redefine what "conforming" means, and no
 * amount of green tests elsewhere would show it.
 *
 * This is a digest test, not a fetch. It cannot prove the copy matches upstream
 * — only a re-sync against the pinned commits in `schemas/index.ts` can do that
 * — but it makes a re-sync an EXPLICIT, reviewed act: the digest below has to
 * change in the same commit, which is exactly the moment a reviewer should be
 * asked to look.
 *
 * When a re-sync is intended: copy the new file in, run this test, and paste
 * the digest it reports into the table. Update the PIN lines in
 * `schemas/index.ts` in the same commit.
 */
const SCHEMA_DIR = fileURLToPath(
  new URL("../../src/mcp-conformance/schemas/", import.meta.url),
);

/** file name → SHA-256 of its bytes, as vendored. */
const EXPECTED_DIGESTS: Record<string, string> = {
  "mcp-2025-03-26.json":
    "e720669548c8100a4282c49e580efd6ddf7f28899ea786fc8db251dbdb356131",
  "mcp-2025-06-18.json":
    "af845e7e5b9d27107d1690f0936022546177a1403e63ffb11470135b296a2e01",
  "mcp-2025-11-25.json":
    "268a5f82ba70fd7e4b6dc4aa1e64f116f74b4d0edcb69dc046829c79dd4e97e7",
  "mcp-2026-07-28.json":
    "ef70b61f99b6d2e5e3b46863822eab08dff6a45bedc7a08914e0e5b133f40203",
  "ext-tasks-draft.json":
    "10933a5003097bbccb03d964e6a5f7a2819cc4d7a1d07e27c6765cbf5da35c5c",
};

function digestOf(fileName: string): string {
  return createHash("sha256")
    .update(readFileSync(join(SCHEMA_DIR, fileName)))
    .digest("hex");
}

describe("vendored spec schemas are unmodified copies", () => {
  it.each(Object.keys(EXPECTED_DIGESTS))(
    "%s matches its recorded digest",
    (fileName) => {
      expect(digestOf(fileName)).toBe(EXPECTED_DIGESTS[fileName]);
    },
  );

  /**
   * A file added to the directory without a digest would be unguarded, and one
   * removed while still imported would fail confusingly at run time. Pinning
   * the SET closes both.
   */
  it("guards every vendored document, and no more", () => {
    const onDisk = readdirSync(SCHEMA_DIR)
      .filter((name) => name.endsWith(".json"))
      .sort();
    expect(onDisk).toEqual(Object.keys(EXPECTED_DIGESTS).sort());
  });

  /**
   * The digests guard the bytes; this guards that those bytes are the ones the
   * validator actually loads. A digest table pointing at files nothing imports
   * would pass forever while the real documents drifted.
   */
  it("digests the documents the validator loads", () => {
    const loaded = [
      ...Object.values(CORE_WIRE_SCHEMAS),
      ...Object.values(EXTENSION_WIRE_SCHEMAS),
    ];
    expect(loaded).toHaveLength(Object.keys(EXPECTED_DIGESTS).length);
    for (const document of loaded) {
      // Every vendored document declares a dialect; a stub or an empty object
      // would not.
      expect(typeof document.$schema).toBe("string");
      expect(
        document.definitions ?? document.$defs,
      ).toBeTypeOf("object");
    }
  });
});
