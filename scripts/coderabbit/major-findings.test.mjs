import assert from "node:assert/strict";
import { test } from "node:test";
import { blockingFindings, blockingSeverity } from "./major-findings.mjs";

const thread = (body, { login = "coderabbitai", isResolved = false } = {}) => ({
  isResolved,
  comments: { nodes: [{ author: { login }, body, path: "a.ts", url: "https://x/1" }] },
});

const MAJOR = "**🎯 Functional Correctness** | **🟠 Major** | **🏗️ Heavy lift**\n\n**Keep checks.**";
const CRITICAL = "**🔒 Security** | **🔴 Critical** | **⚡ Quick win**\n\n**Escape input.**";
const MINOR = "**🩺 Stability** | **🟡 Minor** | **⚡ Quick win**\n\n**Log it.**";

test("reads the severity from the first line only", () => {
  assert.equal(blockingSeverity(MAJOR), "Major");
  assert.equal(blockingSeverity(CRITICAL), "Critical");
  assert.equal(blockingSeverity(MINOR), null);
  assert.equal(blockingSeverity("**🟡 Minor**\n\nThis is a **🟠 Major** concern"), null);
  assert.equal(blockingSeverity(""), null);
});

test("blocks on unresolved Major and Critical CodeRabbit threads", () => {
  const findings = blockingFindings([thread(MAJOR), thread(CRITICAL), thread(MINOR)]);
  assert.deepEqual(
    findings.map((f) => [f.severity, f.title]),
    [["Major", "**Keep checks.**"], ["Critical", "**Escape input.**"]],
  );
});

// The current format: an HTML marker and a blank line come before the grade.
const graded = (icon, grade, headline) =>
  `<!-- coderabbit-ai-generated:v1 -->\n\n**<picture><img src="https://storage.googleapis.com/coderabbit_public_assets/review-comment-icons-v1/${icon}-16.svg" width="16" height="16" align="absmiddle" alt=""></picture> ${grade}** · **Functional Correctness** · **Quick win**\n\n**${headline}**\n\nDetails.`;
const MARKED_MAJOR = graded("major", "Major", "Keep checks.");
const MARKED_CRITICAL = graded("critical", "Critical", "Escape input.");
const MARKED_MINOR = graded("amber", "Minor", "Log it.");

test("reads the grade after the HTML marker in the current format", () => {
  assert.equal(blockingSeverity(MARKED_MAJOR), "Major");
  assert.equal(blockingSeverity(MARKED_CRITICAL), "Critical");
  assert.equal(blockingSeverity(MARKED_MINOR), null);
  const findings = blockingFindings([thread(MARKED_MAJOR), thread(MARKED_CRITICAL), thread(MARKED_MINOR)]);
  assert.deepEqual(
    findings.map((f) => [f.severity, f.title]),
    [["Major", "**Keep checks.**"], ["Critical", "**Escape input.**"]],
  );
});

test("reads the grade after an HTML marker that spans lines", () => {
  const body = MARKED_MAJOR.replace("<!-- coderabbit-ai-generated:v1 -->", "<!--\ncoderabbit-ai-generated:v1\n-->");
  assert.equal(blockingSeverity(body), "Major");
});

test("ignores resolved threads, other authors and empty threads", () => {
  const findings = blockingFindings([
    thread(MAJOR, { isResolved: true }),
    thread(MAJOR, { login: "someone" }),
    { isResolved: false, comments: { nodes: [] } },
  ]);
  assert.deepEqual(findings, []);
});

test("accepts the REST-style bot login", () => {
  assert.equal(blockingFindings([thread(MAJOR, { login: "coderabbitai[bot]" })]).length, 1);
});
