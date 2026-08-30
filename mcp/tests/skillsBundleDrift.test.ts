/**
 * The skills bundle is COMMITTED, and this is what keeps it honest.
 *
 * Two options were available: run the generator during the build, or commit
 * its output and pin it with a test. The build hook is the wrong one here —
 * `build:ui` and `deploy` do not build `@mcpjam/sdk`, and the generator imports
 * it (deliberately: it must parse frontmatter with the SAME function the host
 * re-parses with, or we manufacture our own `frontmatter_drift`). A generator
 * running at deploy time would silently read a stale `sdk/dist`.
 *
 * So the output is committed, and this test regenerates in memory and compares.
 * `npm test -w @mcpjam/mcp` builds the SDK first, so the comparison is against
 * a current parser. Same philosophy as `readme-tool-table.test.ts`: PINNED BY A
 * TEST, NOT EMITTED BY A GENERATOR.
 *
 * If this fails, run `npm run bundle:skills -w @mcpjam/mcp` and commit.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error Local build helper is implemented as plain ESM.
import { buildSkillsBundle, WORKER_SKILL_ROOTS } from "../scripts/generate-skills-bundle.mjs";
import {
  SKILLS_BUNDLE_CONTENTS,
  SKILLS_BUNDLE_ENTRIES,
} from "../src/generated/SkillsBundle.generated.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GENERATED_PATH = join(__dirname, "../src/generated/SkillsBundle.generated.ts");

describe("skills bundle", () => {
  it("matches a fresh regeneration byte for byte", () => {
    const regenerated: string = buildSkillsBundle();
    const committed = readFileSync(GENERATED_PATH, "utf8");
    expect(regenerated).toBe(committed);
  });

  it("covers every root in the worker catalog, and only those", () => {
    // A skill silently dropped from the bundle is a skill silently withdrawn
    // from every connected client.
    const names = SKILLS_BUNDLE_ENTRIES.map(
      (entry) => entry.uri.split("/").at(-2)
    ).sort();
    const expected = (WORKER_SKILL_ROOTS as string[])
      .map((root) => root.split("/").pop())
      .sort();
    expect(names).toEqual(expected);
  });

  it("has content for every manifest URI and no orphans", () => {
    // A manifest entry with no content is a promised read that 404s; a content
    // entry with no manifest row is a file no host is allowed to fetch.
    const manifestUris = SKILLS_BUNDLE_ENTRIES.flatMap((entry) =>
      entry.resources.map((resource) => resource.uri)
    ).sort();
    expect(Object.keys(SKILLS_BUNDLE_CONTENTS).sort()).toEqual(manifestUris);
  });

  it("records the true byte length of each file, not its character count", () => {
    for (const entry of SKILLS_BUNDLE_ENTRIES) {
      for (const resource of entry.resources) {
        const text = SKILLS_BUNDLE_CONTENTS[resource.uri]!;
        expect(
          new TextEncoder().encode(text).byteLength,
          `${resource.uri} size`
        ).toBe(resource.size);
      }
    }
  });
});
