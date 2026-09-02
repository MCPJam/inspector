import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  DECISION_LABEL_VOCABULARIES,
  STAGE_REASON_LABELS,
  STAGE_STATE_LABELS,
} from "@mcpjam/sdk/contract";

/**
 * THE FOURTH RATCHET: the spec's closed vocabularies are the contract's, and
 * every member of them is defined where an agent will actually read it.
 *
 * This exists because of a drift nothing caught. `StageResultRow.reason` in
 * `openapi.json` listed 23 members while `STAGE_REASONS` had 29 — the six the
 * user-value-harness work added (`providerError` and the five judge reasons)
 * were on the wire, in the payloads, and absent from the only document a
 * third-party integrator reads. None of the three existing spec guards could
 * have seen it: `openapi-drift` compares paths and methods and never opens a
 * schema; `openapi-types-parity` compares enums but only for the schemas
 * listed in its `PAIRS`, and these are not among them; the Ajv validation in
 * `eval-decision-summary.test.ts` validates payloads against the spec, and
 * every payload in the corpus happened to use one of the 23.
 *
 * Three assertions per site, and they fail for three different reasons:
 *
 *   MEMBERSHIP — set equality against the contract, in both directions. This
 *   is the one that would have caught the drift, and the one that catches the
 *   next reason somebody adds.
 *
 *   COVERAGE — the property's `description` names every member in backticks.
 *   An agent reading `"reason": "matchVerdictUnavailable"` off the wire has no
 *   other place to look: the meaning is not derivable from the spelling, and
 *   sending it to a doc site it cannot browse is the same as not defining it.
 *
 *   CONTAINMENT (states and reasons) — the description carries the SDK's own
 *   words for the member verbatim. The labels in `decision-labels.ts` are what
 *   the CLI, the web app, Slack and the HTML report all print; a spec that
 *   describes the same member differently is a fifth reading of one run.
 *
 * Stages and failure categories are deliberately exempt from containment:
 * their labels are display NOUNS ("Connection", "tool metadata"), and pasting
 * one into a description would define `connection` as "Connection". Their
 * prose is free-written, and coverage still pins that every member has some.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = resolve(here, "../../../../../docs/reference/openapi.json");

type Schema = {
  enum?: unknown[];
  description?: string;
  properties?: Record<string, Schema>;
  oneOf?: Schema[];
};

const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8")) as {
  components: { schemas: Record<string, Schema> };
};

/**
 * Every place the spec spells one of these vocabularies out.
 *
 * A ratchet like `PAIRS` next door, with one difference that matters: this
 * list is asserted COMPLETE below, so a new copy of a closed vocabulary cannot
 * be added to the spec without being added here too. An unguarded copy is the
 * exact shape of the bug this file was written for.
 */
const SITES = [
  { schema: "EvalIteration", path: ["firstFailedStage"], vocabulary: "stages" },
  {
    schema: "EvalIteration",
    path: ["failureCategory"],
    vocabulary: "failureCategories",
  },
  { schema: "StageResultRow", path: ["stage"], vocabulary: "stages" },
  { schema: "StageResultRow", path: ["state"], vocabulary: "stageStates" },
  { schema: "StageResultRow", path: ["reason"], vocabulary: "stageReasons" },
  { schema: "EvalStageTally", path: ["stage"], vocabulary: "stages" },
  {
    schema: "EvalRunDecisionChain",
    path: ["oneOf", "0", "firstFailedStage"],
    vocabulary: "stages",
  },
  {
    schema: "EvalRunDecisionChain",
    path: ["oneOf", "0", "failureCategory"],
    vocabulary: "failureCategories",
  },
  { schema: "EvalRunDecisionEvidence", path: ["stage"], vocabulary: "stages" },
] as const satisfies readonly {
  schema: string;
  path: readonly string[];
  vocabulary: keyof typeof DECISION_LABEL_VOCABULARIES;
}[];

/** The label map a vocabulary's words come from, where it has one. */
const LABELS: Partial<
  Record<keyof typeof DECISION_LABEL_VOCABULARIES, Record<string, string>>
> = {
  stageStates: STAGE_STATE_LABELS,
  stageReasons: STAGE_REASON_LABELS,
};

function resolveSite(site: (typeof SITES)[number]): Schema {
  let node: Schema | undefined = spec.components.schemas[site.schema];
  expect(node, `openapi.json has no schema "${site.schema}"`).toBeDefined();
  for (const segment of site.path) {
    if (segment === "oneOf") continue;
    node = /^\d+$/.test(segment)
      ? node?.oneOf?.[Number(segment)]
      : node?.properties?.[segment];
    expect(
      node,
      `openapi.json has no ${site.schema}/${site.path.join("/")}`
    ).toBeDefined();
  }
  return node!;
}

describe("openapi.json ↔ the decision vocabularies", () => {
  for (const site of SITES) {
    const label = `${site.schema}.${site.path.filter((s) => s !== "oneOf" && !/^\d+$/.test(s)).join(".")}`;
    const vocabulary = DECISION_LABEL_VOCABULARIES[site.vocabulary];

    it(`${label} lists exactly the ${site.vocabulary} the contract pins`, () => {
      const node = resolveSite(site);
      expect(
        new Set(node.enum as string[]),
        `${label} has drifted from ${site.vocabulary} — the wire carries members ` +
          "the spec does not describe, or describes members the wire never sends"
      ).toEqual(new Set(vocabulary));
      // Set equality alone would accept a duplicated member.
      expect(node.enum).toHaveLength(vocabulary.length);
      // ORDER TOO, but ONLY FOR THE STAGES, because only there is it part of
      // the contract: `USER_VALUE_STAGES` declares its array order normative
      // and `StageResultRow.stage`'s own description — which the coverage
      // check below reads — tells an integrator that `notReached` is derived
      // from position. A spec whose stage enum is shuffled teaches the
      // opposite while every set-based check stays green.
      //
      // The other three vocabularies carry no ordering contract, so pinning
      // them would assert something neither document promises: alphabetizing
      // `failureCategory` in the SDK changes no wire meaning, and a ratchet
      // that reddens for it trains readers to re-order the spec to silence a
      // test rather than because a reader was misled.
      if (site.vocabulary === "stages") {
        expect(
          node.enum,
          `${label} lists the ${site.vocabulary} in a different order from the contract, ` +
            "and their order is normative — `notReached` is derived from position"
        ).toEqual([...vocabulary]);
      }
    });

    it(`${label} defines every member in its own description`, () => {
      const description = resolveSite(site).description ?? "";
      for (const member of vocabulary) {
        expect(
          description,
          `${label} never defines \`${member}\` — an agent reading it off the ` +
            "wire has nowhere else to look"
        ).toContain(`\`${member}\``);
      }
    });

    const labels = LABELS[site.vocabulary];
    if (labels) {
      it(`${label} uses the SDK's own words for each member`, () => {
        const description = resolveSite(site).description ?? "";
        for (const member of vocabulary) {
          expect(
            description,
            `${label} describes \`${member}\` in words that are not ` +
              "`decision-labels.ts`'s — one run, five readings"
          ).toContain(labels[member]);
        }
      });
    }
  }

  it("guards every copy of a closed vocabulary in the spec", () => {
    // Walks the whole document rather than trusting SITES to be current: a
    // vocabulary copied into a new schema and not listed above would be
    // exactly as unguarded as `StageResultRow.reason` was.
    const guarded = new Set(
      SITES.map((site) => [site.schema, ...site.path].join("/"))
    );
    const found = new Set<string>();
    const walk = (node: unknown, path: string[]) => {
      if (Array.isArray(node)) {
        node.forEach((entry, index) => walk(entry, [...path, String(index)]));
        return;
      }
      if (!node || typeof node !== "object") return;
      const members = new Set(
        (Array.isArray((node as Schema).enum) ? (node as Schema).enum! : []).map(
          String
        )
      );
      if (members.size > 0) {
        for (const vocabulary of Object.values(DECISION_LABEL_VOCABULARIES)) {
          // A vocabulary is "spelled out here" when the enum covers three
          // quarters of it — which catches a complete copy AND the 23-of-29
          // drift, while never matching an unrelated enum that happens to
          // share a word or two.
          const overlap = vocabulary.filter((member: string) =>
            members.has(member)
          ).length;
          if (overlap >= Math.ceil(vocabulary.length * 0.75)) {
            found.add(path.join("/"));
          }
        }
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === "enum") continue;
        // `properties` and `oneOf` are structure, not identity: the site is
        // addressed the way SITES addresses it.
        walk(value, key === "properties" ? path : [...path, key]);
      }
    };
    for (const [name, schema] of Object.entries(spec.components.schemas)) {
      walk(schema, [name]);
    }
    expect(
      [...found].filter((site) => !guarded.has(site)).sort(),
      "a closed decision vocabulary is spelled out in openapi.json at a site " +
        "SITES does not list — add it there so its membership and its member " +
        "docs are pinned"
    ).toEqual([]);
    // And the other direction: a site listed here that no longer exists would
    // silently stop guarding anything.
    expect([...guarded].filter((site) => !found.has(site)).sort()).toEqual([]);
  });
});
