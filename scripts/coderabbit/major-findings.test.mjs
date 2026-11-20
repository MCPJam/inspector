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
