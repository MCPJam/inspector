import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { checkErrorRules, errorsSection } from "../check-error-rules.mjs";
import { rubric, copyRubric, classify } from "../slop/copy-review.mjs";

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

test("rubric(path) loads only the requested prompt", () => {
  for (const name of ["review-triage.md", "adversarial-review.md"]) {
    const path = new URL(`../slop/${name}`, import.meta.url);
    assert.equal(
      rubric(path),
      readFileSync(path, "utf8").replace(/^---[\s\S]*?\n---\n/, ""),
    );
  }
});

test("shared prompt loading works in the scripts/slop-only trusted checkout", t => {
  const root = mkdtempSync(join(tmpdir(), "copy-review-sparse-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const slop = join(root, "scripts/slop");
  cpSync(new URL("../slop", import.meta.url), slop, { recursive: true });
  const module = pathToFileURL(join(slop, "copy-review.mjs")).href;
  const runner = join(root, "load-prompt.mjs");
  for (const name of ["review-triage.md", "adversarial-review.md"]) {
    const prompt = join(slop, name);
    const script = `import { rubric } from ${JSON.stringify(module)}; process.stdout.write(rubric(${JSON.stringify(prompt)}));`;
    writeFileSync(runner, script);
    assert.equal(
      execFileSync(process.execPath, [runner], { cwd: root, encoding: "utf8" }),
      rubric(prompt),
    );
  }
});

test("the copy-specific rubric includes the standard but not the full-tree reviewer mechanics", async () => {
  const text = await copyRubric();
  assert.match(text, /\*\*E1 — Plain language/);
  assert.match(text, /Validation never goes in a toast/);
  assert.doesNotMatch(text, /## Order of decision|## Calibration|Stop at the first failure/);
});

test("classification receives the copy rubric without conflicting repository-review instructions", async () => {
  let request;
  await classify([{ id: 1, path: "example.tsx", text: "Couldn't save the server." }], await copyRubric(), async input => {
    request = input;
    return { items: [], usage: {} };
  });
  assert.match(request.system, /\*\*E1 — Plain language/);
  assert.doesNotMatch(request.system, /Capability boundary|## Order of decision|You have the full working tree/);
  assert.deepEqual(JSON.parse(request.user), [{ id: 1, path: "example.tsx", text: "Couldn't save the server." }]);
});

test("the check resolves repository files independently of cwd", () => {
  const output = execFileSync(process.execPath, [new URL("../check-error-rules.mjs", import.meta.url).pathname],
    { cwd: "/", encoding: "utf8" });
  assert.match(output, /defined, applied, and linked/);
});
