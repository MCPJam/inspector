import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkErrorRules, errorsSection } from "../check-error-rules.mjs";
import { rubric } from "../slop/copy-review.mjs";

const design = `# Design
## Errors
**E1 — Plain language.**
**E2 — Precisely indicates the problem.**
**E3 — Offers a way out.**
**E4 — Consistent.**
## Other
**E9 — Not an error rule.**
`;
const reviewer = `Read DESIGN.md.
## Order of decision
1. Apply E1.
2. Apply E2.
3. Apply E3.
4. Apply E4.
## Calibration
Cites E1 and E4.
`;
const copy = "Read DESIGN.md and .agents/skills/error-message-review/SKILL.md.";
const check = (d = design, s = reviewer, c = copy) => checkErrorRules(d, s, c);

test("each canonical rule is defined, cited and applied", () => {
  assert.deepEqual(check(), []);
});

test("the Errors section can be the final section", () => {
  assert.deepEqual(check(design.split("## Other")[0]), []);
});

test("non-error headings and references outside the section are ignored", () => {
  assert.doesNotMatch(errorsSection(design), /E9/);
  assert.ok(check(design, reviewer + "E9").some(e => e.includes("undefined E9")));
});

test("missing section and definitions fail closed", () => {
  assert.ok(check("# Design").some(e => e.includes('no "## Errors"')));
  assert.ok(check("## Errors\nNo rules").some(e => e.includes("no E-rules")));
});

test("duplicate definitions fail", () => {
  assert.ok(check(design.replace("## Other", "**E1 — Again.**\n## Other"))
    .some(e => e.includes("duplicate")));
});

test("undefined citations anywhere in the reviewer fail", () => {
  assert.ok(check(design, reviewer + "E5").some(e => e.includes("undefined E5")));
});

test("calibration citations do not substitute for applying a rule", () => {
  assert.ok(check(design, reviewer.replace("4. Apply E4.", ""))
    .some(e => e.includes("does not apply E4")));
});

test("a new canonical rule must be applied", () => {
  assert.ok(check(design.replace("## Other", "**E5 — New rule.**\n## Other"))
    .some(e => e.includes("does not apply E5")));
});

test("missing decision order fails, including one in unrelated text", () => {
  assert.ok(check(design, "Read DESIGN.md. E1 E2 E3 E4")
    .some(e => e.includes("no decision order")));
});

test("the final reviewer section may be the decision order", () => {
  assert.deepEqual(check(design, reviewer.split("## Calibration")[0]), []);
});

test("both reviewing entry points must cite the canonical files", () => {
  assert.ok(check(design, reviewer.replace("DESIGN.md", "another file"))
    .some(e => e.includes("must reference DESIGN.md")));
  for (const c of ["Read DESIGN.md", ".agents/skills/error-message-review/SKILL.md", ""]) {
    assert.ok(check(design, reviewer, c).some(e => e.includes("ui-copy must reference")));
  }
});

test("committed standard and reviewer stay in sync", () => {
  const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  assert.deepEqual(check(read("DESIGN.md"), read(".agents/skills/error-message-review/SKILL.md"),
    read(".agents/skills/ui-copy/SKILL.md")), []);
});

test("the trusted AI rubric contains the canonical standard and decision order", () => {
  assert.match(rubric(), /\*\*E1 — Plain language/);
  assert.match(rubric(), /## Order of decision/);
  assert.match(rubric(), /Validation never goes in a toast/);
});

test("the check resolves repository files independently of cwd", () => {
  const output = execFileSync(process.execPath, [new URL("../check-error-rules.mjs", import.meta.url).pathname],
    { cwd: "/", encoding: "utf8" });
  assert.match(output, /defined, applied, and linked/);
});
