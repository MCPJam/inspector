import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { designContext, isUiPath, specFromBody, specReferences } from "./review-spec.mjs";

const TEMPLATE = readFileSync(new URL("../../.github/pull_request_template.md", import.meta.url), "utf8");

test("UI files are components, styles and pages, not their tests or stories", () => {
  assert.deepEqual(["a/B.tsx", "s.css", "p.html", "a/__tests__/B.tsx", "B.test.tsx", "B.stories.tsx", "a.ts"].filter(isUiPath),
    ["a/B.tsx", "s.css", "p.html"]);
});

test("the untouched PR template has no spec, user story or acceptance criteria", () => {
  assert.deepEqual(specFromBody(TEMPLATE), { spec: "", userStory: "", acceptance: "" });
});

test("a filled-in description yields its spec line, user story and acceptance criteria", () => {
  const body = TEMPLATE
    .replace("- **Spec:** <!--", "- **Spec:** docs/specs/runs.md <!--")
    .replace("**As a** ...,", "**As a** hosted evals user,")
    .replace("- [ ] ...", "- [ ] The run list shows an empty state with a Create button");
  const spec = specFromBody(body);
  assert.equal(spec.spec, "docs/specs/runs.md");
  assert.match(spec.userStory, /hosted evals user/);
  assert.doesNotMatch(spec.userStory, /Acceptance/);
  assert.match(spec.acceptance, /empty state with a Create button/);
});

test("spec references split into repository files and links CI cannot read", () => {
  assert.deepEqual(specReferences("https://github.com/MCPJam/inspector/blob/main/docs/a.md and ./docs/b.md", "MCPJam/inspector"),
    { paths: ["docs/a.md", "docs/b.md"], external: [] });
  assert.deepEqual(specReferences("https://app.kestral.ai/w/doc/1, https://github.com/other/repo/blob/main/x.md", "MCPJam/inspector"),
    { paths: [], external: ["https://app.kestral.ai/w/doc/1", "https://github.com/other/repo/blob/main/x.md"] });
  assert.deepEqual(specReferences("../../etc/passwd.md /abs.md", "o/r").paths, []);
});

test("design context is only built for UI changes, and reads repository specs from the PR head", () => {
  const readDesign = () => "DESIGN";
  assert.equal(designContext({ changedPaths: ["server/a.ts"], body: "", repo: "o/r", readFile: () => null, readDesign }), null);
  const body = "- **Spec:** docs/spec.md and https://app.kestral.ai/doc/2\n";
  const context = designContext({
    changedPaths: ["client/A.tsx", "server/a.ts"], body, repo: "o/r", readDesign,
    readFile: (path) => (path === "docs/spec.md" ? "# Spec" : null),
  });
  assert.deepEqual(context.uiFiles, ["client/A.tsx"]);
  assert.equal(context.design, "DESIGN");
  assert.deepEqual(context.spec.documents, [{ path: "docs/spec.md", content: "# Spec" }]);
  assert.deepEqual(context.notes, [], "a readable repository spec needs no note about the external link");
});

test("a missing spec or an unreadable link is noted instead of guessed", () => {
  const unreadable = designContext({
    changedPaths: ["A.tsx"], body: "- **Spec:** https://app.kestral.ai/doc/2", repo: "o/r",
    readFile: () => null, readDesign: () => { throw new Error("gone"); },
  });
  assert.equal(unreadable.design, null);
  assert.match(unreadable.notes.join("\n"), /DESIGN\.md could not be read[\s\S]*link CI cannot read[\s\S]*design system only/);
});
