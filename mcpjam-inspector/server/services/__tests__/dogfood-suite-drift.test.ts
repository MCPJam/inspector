import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The dogfood suite exists twice, once per environment, and the two copies must
 * ask the same questions.
 *
 * Why two files at all: a file-owned suite always carries an environment, and
 * `eval run --server` against one is refused with
 * `ENVIRONMENT_SERVERS_NOT_OVERRIDABLE`, so a single file cannot be pointed at
 * staging for the promotion gate and at production for the nightly monitor.
 * That refusal is correct rather than inconvenient: a suite's run history is
 * only comparable within one target, so one suite spanning two servers would
 * quietly corrupt every baseline comparison.
 *
 * What that leaves is the ordinary duplication hazard — someone fixes a case in
 * one file and the other silently measures something else. This test is the
 * thing that stops it. Everything ABOVE `cases:` is deliberately allowed to
 * differ (identity, target, prose); everything from `cases:` down must match
 * byte for byte.
 */
const EVALS_DIR = join(__dirname, "..", "..", "..", "..", ".mcpjam", "evals");
const STAGING = "mcpjam-mcp.yaml";
const PRODUCTION = "mcpjam-mcp-production.yaml";

function read(name: string): string {
  return readFileSync(join(EVALS_DIR, name), "utf8");
}

function casesBlock(source: string, name: string): string {
  const marker = "\ncases:\n";
  const at = source.indexOf(marker);
  // A rename of `cases:` would otherwise make this test vacuously pass by
  // comparing two empty strings.
  expect(at, `${name} must contain a top-level 'cases:' block`).toBeGreaterThan(
    -1,
  );
  return source.slice(at + marker.length);
}

describe("the dogfood eval suites", () => {
  it("ask identical questions of staging and production", () => {
    expect(casesBlock(read(PRODUCTION), PRODUCTION)).toBe(
      casesBlock(read(STAGING), STAGING),
    );
  });

  it("carry distinct identities, so neither can claim the other's suite", () => {
    const ids = [STAGING, PRODUCTION].map((name) => {
      const match = /^ {2}id: (\S+)$/m.exec(read(name));
      expect(match, `${name} must declare suite.id`).not.toBeNull();
      return match![1];
    });
    expect(ids[0]).not.toBe(ids[1]);

    const names = [STAGING, PRODUCTION].map((file) => {
      const match = /^ {2}name: (.+)$/m.exec(read(file));
      expect(match, `${file} must declare suite.name`).not.toBeNull();
      return match![1].trim();
    });
    // The SDK upload path joins on suite NAME, so two suites sharing one name
    // in a project would send local runs into whichever row is older.
    expect(names[0]).not.toBe(names[1]);
  });

  it("each target exactly one server, and not the same one", () => {
    const targets = [STAGING, PRODUCTION].map((file) => {
      const source = read(file);
      const block = source.slice(
        source.indexOf("\ntarget:\n"),
        source.indexOf("\ndefaults:\n"),
      );
      const servers = [...block.matchAll(/^ {4}- name: (\S+)$/gm)].map(
        (m) => m[1],
      );
      expect(servers, `${file} must target exactly one server`).toHaveLength(1);
      return servers[0];
    });
    expect(targets).toEqual(["mcpjam-mcp-staging", "mcpjam-mcp"]);
  });
});
