/**
 * The glossary skill is ANOTHER hand-maintained copy of the vocabulary, so it
 * gets the same totality discipline as every other copy.
 *
 * `decision-labels.ts` exists because each surface used to invent its own
 * rendering of the same enums. A served reference document that names 27 of 29
 * reasons is the same failure in a new place, and worse than most: the two it
 * omits are exactly the two an agent will look up, because they are the ones
 * it has not seen before. There is no partial credit here — a glossary is only
 * a glossary if it is complete.
 *
 * Two assertions:
 *
 *   MEMBERSHIP — every member of every vocabulary in
 *   `DECISION_LABEL_VOCABULARIES` appears in the document, in backticks, as
 *   the wire spelling an agent will actually read off a payload.
 *
 *   CONTAINMENT — every stage-reason and stage-state LABEL appears verbatim.
 *   The words are what the CLI, the web app, Slack and the HTML report print;
 *   a glossary that paraphrases them defines a different vocabulary from the
 *   one the reader is holding.
 *
 * When this fails: copy the SDK's wording into the SKILL.md, then run
 * `npm run bundle:skills -w @mcpjam/mcp` and commit the regenerated bundle.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DECISION_LABEL_VOCABULARIES,
  EVAL_STAGE_EXCLUSION_CLASSES,
  STAGE_REASON_LABELS,
  STAGE_STATE_LABELS,
} from "@mcpjam/sdk/contract";
// @ts-expect-error Local build helper is implemented as plain ESM.
import { WORKER_SKILL_ROOTS } from "../scripts/generate-skills-bundle.mjs";
import { SKILLS_BUNDLE_CONTENTS } from "../src/generated/SkillsBundle.generated.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = "skills/user-value-chain-glossary";
const SKILL_PATH = join(__dirname, "../..", SKILL_ROOT, "SKILL.md");
const markdown = readFileSync(SKILL_PATH, "utf8");

describe("the user-value-chain glossary", () => {
  it("is served by the worker", () => {
    // A glossary nobody can fetch is a file, not a skill. The tool
    // descriptions point at it by name, so it has to actually be there.
    expect(WORKER_SKILL_ROOTS as string[]).toContain(SKILL_ROOT);
    const uri = Object.keys(SKILLS_BUNDLE_CONTENTS).find((key) =>
      key.endsWith("/user-value-chain-glossary/SKILL.md")
    );
    expect(uri, "the glossary is missing from the served bundle").toBeDefined();
    expect(SKILLS_BUNDLE_CONTENTS[uri!]).toBe(markdown);
  });

  it("declares the name its directory promises", () => {
    // `checkSkillIdentity` refuses a mismatch at bundle time; asserting it
    // here names the rule rather than leaving it as a build failure to
    // decipher.
    expect(markdown.startsWith("---\nname: user-value-chain-glossary\n")).toBe(
      true
    );
  });

  for (const [vocabulary, members] of Object.entries(
    DECISION_LABEL_VOCABULARIES
  )) {
    it(`names every ${vocabulary} member`, () => {
      for (const member of members as readonly string[]) {
        expect(
          markdown,
          `the glossary never defines \`${member}\` — an agent that meets it ` +
            "on the wire has nowhere left to look"
        ).toContain(`\`${member}\``);
      }
    });
  }

  it("names every stage-analytics exclusion class", () => {
    // Not in DECISION_LABEL_VOCABULARIES (it is the analytics contract's own
    // vocabulary), and just as much a closed list an agent has to read.
    for (const member of EVAL_STAGE_EXCLUSION_CLASSES) {
      expect(markdown).toContain(`\`${member}\``);
    }
  });

  for (const [name, labels] of [
    ["stage reason", STAGE_REASON_LABELS],
    ["stage state", STAGE_STATE_LABELS],
  ] as const) {
    it(`quotes every ${name} label verbatim`, () => {
      for (const [member, label] of Object.entries(labels)) {
        expect(
          markdown,
          `the glossary paraphrases \`${member}\` instead of using ` +
            "`decision-labels.ts`'s own words — one vocabulary, two readings"
        ).toContain(label);
      }
    });
  }

  it("states the claims the vocabulary exists to protect", () => {
    // The three misreadings this whole contract is built against. A glossary
    // that lists members without them is a lookup table, and a lookup table is
    // what produced "we never checked" rendered as "it passed".
    expect(markdown).toContain("A first failed stage is a LOCATION");
    expect(markdown).toContain(
      "neither on its own authorizes proposing a change to the server"
    );
    expect(markdown).toContain("A zero denominator is NOT MEASURED");
    expect(markdown).toContain("There is no backfill");
    expect(markdown).toContain("Never sum stage tallies across stages");
  });
});
