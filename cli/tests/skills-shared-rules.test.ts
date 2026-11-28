/**
 * Some rules are repeated word for word across skills, because an agent
 * loads one skill at a time and must not miss them. Each copy must stay
 * identical: when one changes, change every file listed with it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const skillsRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../skills",
);

const CLOUD = "mcpjam-cloud/SKILL.md";
const INSPECTOR = "mcp-inspector/SKILL.md";
const EVALS = "run-mcpjam-evals/SKILL.md";

const SHARED_RULES: { rule: string; files: string[] }[] = [
  {
    rule: "Never run `mcpjam cloud …` to test a server the user gave you by URL when a local command answers the question. Local commands reach it directly; Cloud commands act on the user's MCPJam projects.",
    files: [CLOUD, INSPECTOR],
  },
  {
    rule: "needs an MCPJam login or `sk_` key for every run, BYOK included",
    files: [CLOUD, INSPECTOR],
  },
  {
    rule: "`mcpjam conformance run` uploads its results whenever `MCPJAM_API_KEY` is set. The single-suite conformance commands upload only with `--upload`.",
    files: [CLOUD, INSPECTOR],
  },
  {
    rule: "the immediate fix for their plan, at `https://app.mcpjam.com/billing`: on a Free plan, upgrade to Pro (Free plans cannot buy credits); on a paid plan, buy credits.",
    files: [CLOUD, EVALS],
  },
  {
    rule: "BYOK (their own provider keys) to stop MCPJam inference charges. You cannot add the keys. BYOK does not remove platform fees.",
    files: [CLOUD, EVALS],
  },
  {
    rule: "Waiting for credits to reset is the last option, not the first.",
    files: [CLOUD, EVALS],
  },
  {
    rule: "Never pay, upgrade, or buy credits yourself.",
    files: [CLOUD, EVALS],
  },
  {
    rule: "can say to check the server connection when the cause was a model or credit failure, even with the `connection` and `discovery` stages `passed`. Trust the stage states and the iteration's error over that line. This is a known bug, fixed by https://github.com/MCPJam/inspector/pull/7873.",
    files: [CLOUD, EVALS],
  },
];

// Line wrapping is not a divergence.
const normalize = (text: string) => text.replace(/\s+/g, " ");

test("rules repeated across skills stay identical", () => {
  const skills = new Map<string, string>();
  const read = (file: string) => {
    if (!skills.has(file)) {
      skills.set(
        file,
        normalize(readFileSync(path.join(skillsRoot, file), "utf8")),
      );
    }
    return skills.get(file)!;
  };

  for (const { rule, files } of SHARED_RULES) {
    for (const file of files) {
      assert.ok(
        read(file).includes(normalize(rule)),
        `${file} no longer carries this rule word for word; update every copy (${files.join(", ")}):\n${rule}`,
      );
    }
  }
});
