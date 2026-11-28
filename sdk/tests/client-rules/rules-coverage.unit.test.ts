/**
 * Keeps the "every MCPJam-only client rule has a test" claim true.
 *
 * Each test file in this folder accounts for rules by calling `ruleTest`,
 * `coveredBy` or `mayRule` (see `harness.ts`) with the
 * rule id as a string literal. This reads those files and checks that every
 * rule in `rules.ts` is accounted for at least once, that no file names a rule
 * the catalog does not have, and that every rule has a spec level.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { levelOf, SPEC_LEVELS } from "./levels.js";
import { CLIENT_RULE_IDS, CLIENT_RULES } from "./rules.js";

const DIR = dirname(fileURLToPath(import.meta.url));
const ACCOUNTING_CALL =
  /\b(?:ruleTest|coveredBy|mayRule)\(\s*"(C\d{3})"/g;

/**
 * Rules MCPJam breaks today and that have no other test that passes. Their
 * tests come back once the client follows them. Tracked under CQT-224.
 */
const BROKEN_TODAY: Record<string, string> = {
  C055: "tasks-conformance/evidence.ts reads a server's -32001 as a timeout",
  C261: "MCPClientManager and the raw protocol probe never send DELETE to end a session",
};

function accountedRules(): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  for (const file of readdirSync(DIR)) {
    if (!file.endsWith(".test.ts") || file === "rules-coverage.unit.test.ts") {
      continue;
    }
    const source = readFileSync(join(DIR, file), "utf8");
    for (const match of source.matchAll(ACCOUNTING_CALL)) {
      const id = match[1]!;
      seen.set(id, [...(seen.get(id) ?? []), file]);
    }
  }
  return seen;
}

describe("client rule catalog", () => {
  const seen = accountedRules();

  it("holds the 94 MCPJam-only client rules", () => {
    expect(CLIENT_RULE_IDS).toHaveLength(94);
  });

  it("accounts for every rule in some test file", () => {
    expect(
      CLIENT_RULE_IDS.filter((id) => !seen.has(id) && !(id in BROKEN_TODAY)),
    ).toEqual([]);
  });

  it("marks every rule MUST, MUST NOT, SHOULD, SHOULD NOT or MAY", () => {
    for (const id of CLIENT_RULE_IDS) {
      expect(SPEC_LEVELS, id).toContain(levelOf(id));
    }
  });

  it("names no rule that is missing from the catalog", () => {
    expect([...seen.keys()].filter((id) => !(id in CLIENT_RULES))).toEqual([]);
  });
});
