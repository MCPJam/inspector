import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MARKER,
  commentBody,
  evaluate,
  evidenceSection,
  exemption,
  isUserVisible,
  mediaRefs,
} from "./pr-evidence.mjs";

const HEAD = "59b34499f0c1d2e3a4b5c6d7e8f9a0b1c2d3e4f5";
const UI = ["mcpjam-inspector/client/src/components/logger-view.tsx"];
const SERVER = ["mcpjam-inspector/server/routes/mcp/events.ts"];

// The real template's section, so a placeholder edit there is caught here.
const TEMPLATE_SECTION = readFileSync(
  new URL("../pull_request_template.md", import.meta.url),
  "utf8",
).match(/## Screenshots and recordings[\s\S]*?(?=\n## )/)[0];

const body = (evidence) =>
  `## What this does\n\nText.\n\n## Screenshots and recordings\n\n${evidence}\n\n## Deleted\n\nNothing`;

const rules = async (input) =>
  (
    await evaluate({
      headSha: HEAD,
      compare: async () => null,
      ...input,
    })
  ).map((f) => f.rule);

test("user-visible source is UI package code, not tests, stories or the server", () => {
  assert.ok(isUserVisible("mcpjam-inspector/client/src/components/logger-view.tsx"));
  assert.ok(isUserVisible("design-system/src/button.tsx"));
  assert.ok(isUserVisible("chat-ui/src/message.tsx"));
  for (const path of [
    "mcpjam-inspector/client/src/components/__tests__/logger-view.test.tsx",
    "mcpjam-inspector/client/src/components/logger-view.stories.tsx",
    "mcpjam-inspector/server/routes/mcp/events.ts",
    "docs/inspector/events.mdx",
  ]) {
    assert.ok(!isUserVisible(path), path);
  }
});

test("missing: a UI change with the untouched template section is flagged", async () => {
  const pr = `## What this does\n\nText.\n\n${TEMPLATE_SECTION}\n## Deleted\n\nNothing`;
  assert.equal(evidenceSection(pr), "| Before | After |\n| --- | --- |\n|  |  |");
  assert.deepEqual(await rules({ body: pr, files: UI }), ["missing"]);
});

test("missing: a UI change that says None, or has no section, is flagged", async () => {
  assert.deepEqual(await rules({ body: body("None: no UI change"), files: UI }), ["missing"]);
  assert.deepEqual(await rules({ body: "## What this does\n\nText.", files: UI }), ["missing"]);
});

test("missing: a comment nested to survive one strip pass is still removed", async () => {
  const pr = body("<!<!---->-- ![a](/home/u/a.png) -->");
  assert.equal(evidenceSection(pr), "");
  assert.deepEqual(mediaRefs(pr), []);
  assert.deepEqual(await rules({ body: pr, files: UI }), ["missing"]);
});

test("missing near miss: a server-only change may say None", async () => {
  assert.deepEqual(await rules({ body: body("None: no UI change"), files: SERVER }), []);
});

test("missing near miss: a text-only before and after table is evidence", async () => {
  const table = "| Before | After |\n| --- | --- |\n| Tool Count: 8 | Tool count |";
  assert.deepEqual(await rules({ body: body(table), files: UI }), []);
});

test("unreachable: Devin proxy, file: and local paths are flagged", async () => {
  for (const ref of [
    "![after](https://app.devin.ai/api/presigned_proxy?token=abc.def.ghi)",
    '<img src="file:///Users/me/shot.png">',
    "/home/ubuntu/screenshots/after.png",
    "C:\\Users\\me\\Pictures\\after.png",
    "C:/Users/me/Pictures/after.png",
  ]) {
    const findings = await evaluate({
      body: body(ref),
      files: SERVER,
      headSha: HEAD,
      compare: async () => null,
    });
    assert.deepEqual(findings.map((f) => f.rule), ["unreachable"], ref);
    assert.ok(!findings[0].message.includes("token="), "drops the presigned token");
  }
});

test("unreachable near miss: GitHub-hosted media and a /Users path in prose pass", async () => {
  const pr = body(
    "![after](https://github.com/user-attachments/assets/1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d)\n" +
      "Fixes path handling for /Users/me/project on macOS.\n" +
      "![Card gap 0/2/4px](https://github.com/user-attachments/assets/gap)",
  );
  assert.deepEqual(await rules({ body: pr, files: UI }), []);
});

test("a slash inside alt text is not read as a path", () => {
  const url = "https://github.com/user-attachments/assets/gap.png";
  assert.deepEqual(mediaRefs(`![Card gap 0/2/4px](${url})`), [url]);
});

test("stale: evidence at a commit the head is ahead of is flagged", async () => {
  const seen = [];
  const findings = await evaluate({
    body: body("Ran QA at `42eee52`. ![a](https://github.com/user-attachments/assets/x)"),
    files: UI,
    headSha: HEAD,
    compare: async (sha) => (seen.push(sha), "ahead"),
  });
  assert.deepEqual(findings.map((f) => f.rule), ["stale"]);
  assert.deepEqual(seen, ["42eee52"]);
  assert.match(findings[0].message, /`42eee52`.*`59b3449`/);
});

test("stale near miss: the head, a commit containing it, or another repo's SHA passes", async () => {
  const evidence = (sha) =>
    body(`QA at \`${sha}\`. ![a](https://github.com/user-attachments/assets/x)`);
  assert.deepEqual(
    await rules({ body: evidence("59b3449"), files: UI, compare: async () => "ahead" }),
    [],
  );
  assert.deepEqual(
    await rules({ body: evidence("82a22f8"), files: UI, compare: async () => "behind" }),
    [],
  );
  assert.deepEqual(
    await rules({ body: evidence("13300611d"), files: UI, compare: async () => null }),
    [],
  );
});

test("stale near miss: hex ids inside upload links are not commit SHAs", async () => {
  const pr = body(
    "![a](https://github.com/user-attachments/assets/1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d)",
  );
  assert.deepEqual(
    await rules({ body: pr, files: UI, compare: async () => "ahead" }),
    [],
  );
});

test("mechanical and Dependabot PRs are exempt; other labels are not", () => {
  assert.equal(exemption({ labels: ["mechanical"], author: "olartgabo" }), "labelled mechanical");
  assert.equal(exemption({ labels: [], author: "dependabot[bot]" }), "Dependabot");
  assert.equal(exemption({ labels: ["large-pr"], author: "olartgabo" }), null);
});

test("the comment starts with the marker the workflow finds it by", () => {
  assert.ok(commentBody([]).startsWith(`${MARKER}\n`));
  const text = commentBody([{ rule: "missing", message: "No evidence." }]);
  assert.ok(text.startsWith(MARKER));
  assert.match(text, /advisory/);
  assert.match(text, /- No evidence\./);
});
