import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { StructuredRunReport } from "@mcpjam/sdk";
import {
  buildEvalDecisionSummary,
  formatEvalDecisionSummary,
} from "@mcpjam/sdk";
import {
  parseReporterFormat,
  writeEvalDecisionSummary,
  writeJsonArtifact,
  writeReporterArtifact,
  writeReporterResult,
} from "../src/lib/reporting.js";

function makeReport(): StructuredRunReport {
  return {
    schemaVersion: 1,
    kind: "tools-call-validation",
    passed: true,
    summary: {
      total: 1,
      passed: 1,
      failed: 0,
      byCategory: {
        protocol: { total: 1, passed: 1, failed: 0 },
      },
    },
    cases: [
      {
        id: "tool-call-envelope-valid",
        title: "tool-call-envelope-valid",
        category: "protocol",
        passed: true,
      },
    ],
    durationMs: 10,
    metadata: {
      redactedRawResult: {
        contentCount: 1,
        content: [
          {
            type: "text",
            textLength: 42,
            textPreview: "Authorization: Bearer top-secret",
          },
        ],
      },
    },
  };
}

test("parseReporterFormat validates supported reporters", () => {
  assert.equal(parseReporterFormat(undefined), undefined);
  assert.equal(parseReporterFormat("json-summary"), "json-summary");
  assert.equal(parseReporterFormat("junit-xml"), "junit-xml");
  assert.equal(parseReporterFormat("html"), "html");
});

test("parseReporterFormat rejects an unknown reporter, naming all three formats", () => {
  assert.throws(
    () => parseReporterFormat("yaml"),
    /Invalid reporter "yaml"\. Use "json-summary", "junit-xml", or "html"\./
  );
});

test("writes decision summaries only for human output", () => {
  const summary = buildEvalDecisionSummary({
    total: 1,
    passed: 0,
    failed: 1,
    iterationWalkComplete: true,
    cases: [
      {
        id: "iteration-1",
        title: "Setup abort",
        iterationNumber: 1,
        result: "failed",
        failureCategory: "setup",
        stageResults: [
          { stage: "connection", state: "notMeasured" },
          { stage: "discovery", state: "notMeasured" },
          { stage: "selection", state: "notMeasured" },
          { stage: "call", state: "notMeasured" },
          { stage: "response", state: "notMeasured" },
          { stage: "userValue", state: "notMeasured" },
        ],
        stageAnalyzerVersion: 2,
      },
    ],
  });
  assert.equal(formatEvalDecisionSummary(summary).includes("failure category setup"), true);
  const original = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    if (typeof chunk === "string") output += chunk;
    return true;
  }) as typeof process.stdout.write;
  try {
    writeEvalDecisionSummary("human", summary, process.stdout);
    assert.match(output, /did not reach the server's stages/);
    output = "";
    writeEvalDecisionSummary("json", summary, process.stdout);
    assert.equal(output, "");
  } finally {
    process.stdout.write = original;
  }
});

test("writes decision summaries to the supplied destination", () => {
  const summary = buildEvalDecisionSummary({
    total: 1,
    passed: 0,
    failed: 1,
    iterationWalkComplete: true,
    cases: [
      {
        id: "iteration-1",
        title: "Setup abort",
        iterationNumber: 1,
        result: "failed",
        failureCategory: "setup",
        stageResults: [
          { stage: "connection", state: "notMeasured" },
          { stage: "discovery", state: "notMeasured" },
          { stage: "selection", state: "notMeasured" },
          { stage: "call", state: "notMeasured" },
          { stage: "response", state: "notMeasured" },
          { stage: "userValue", state: "notMeasured" },
        ],
        stageAnalyzerVersion: 2,
      },
    ],
  });
  let stderr = "";
  const destination = {
    write(chunk: string | Uint8Array) {
      stderr += String(chunk);
      return true;
    },
  };

  writeEvalDecisionSummary("human", summary, destination);

  assert.match(stderr, /Decision summary: failed/);
});

test("writeReporterResult emits redacted json-summary output", () => {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let stdout = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;

  try {
    writeReporterResult("json-summary", makeReport());
  } finally {
    process.stdout.write = originalWrite;
  }

  const payload = JSON.parse(stdout);
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.kind, "tools-call-validation");
  assert.equal(
    payload.metadata.redactedRawResult.content[0].textPreview,
    "Authorization: [REDACTED]",
  );
});

test("writeReporterResult emits junit xml", () => {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let stdout = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;

  try {
    writeReporterResult("junit-xml", {
      ...makeReport(),
      kind: "server-diff",
      cases: [],
      summary: {
        total: 0,
        passed: 0,
        failed: 0,
        byCategory: {},
      },
    });
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.match(stdout, /<testsuites/);
  assert.match(stdout, /classname="mcpjam\.server-diff"/);
  assert.match(stdout, /name="no-drift"/);
});

test("writeJsonArtifact writes json to disk", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-reporting-"));
  const artifactPath = path.join(directory, "report.json");

  const writtenPath = await writeJsonArtifact(artifactPath, {
    ok: true,
  });
  const payload = JSON.parse(await readFile(writtenPath, "utf8"));

  assert.deepEqual(payload, { ok: true });
});

// `--out` and `--reporter` are two exports of the same run. The reporter half
// has always been redacted (see the json-summary test above); the file half was
// not, so the same report left clean through one flag and in the clear through
// the other.
test("writeJsonArtifact redacts the artifact it writes to disk", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-reporting-"));
  const artifactPath = path.join(directory, "report.json");

  const writtenPath = await writeJsonArtifact(artifactPath, makeReport());
  const raw = await readFile(writtenPath, "utf8");
  const payload = JSON.parse(raw);

  assert.equal(
    payload.metadata.redactedRawResult.content[0].textPreview,
    "Authorization: [REDACTED]",
  );
  assert.equal(raw.includes("top-secret"), false);
  // Non-sensitive fields must survive — a redactor that eats the report is not
  // a fix.
  assert.equal(payload.kind, "tools-call-validation");
  assert.equal(payload.schemaVersion, 1);
});

test("writeJsonArtifact keeps planted credentials out of an exported run", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-reporting-"));
  const artifactPath = path.join(directory, "report.json");

  const canary = "at_canary_1a2b3c4d5e6f7g8h9i0j";
  const writtenPath = await writeJsonArtifact(artifactPath, {
    ok: false,
    servers: [{ serverId: "asana", accessToken: canary }],
    error: `connection refused (authorization: Bearer ${canary})`,
  });
  const raw = await readFile(writtenPath, "utf8");

  assert.equal(raw.includes(canary), false);
});

test("writeReporterArtifact writes redacted junit atomically", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-reporting-"));
  const artifactPath = path.join(directory, "report.xml");
  const report = makeReport();
  report.passed = false;
  report.summary = {
    total: 1,
    passed: 0,
    failed: 1,
    byCategory: {
      protocol: { total: 1, passed: 0, failed: 1 },
    },
  };
  report.cases[0] = {
    ...report.cases[0],
    passed: false,
    error: "Authorization: Bearer top-secret",
  };

  const writtenPath = await writeReporterArtifact(
    artifactPath,
    "junit-xml",
    report
  );
  const raw = await readFile(writtenPath, "utf8");

  assert.match(raw, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(raw, /<failure message="Authorization: \[REDACTED\]"/);
  assert.equal(raw.includes("top-secret"), false);
  assert.deepEqual(await readdir(directory), ["report.xml"]);
});

function makeFailedReport(): StructuredRunReport {
  const report = makeReport();
  report.passed = false;
  report.summary = {
    total: 1,
    passed: 0,
    failed: 1,
    byCategory: {
      protocol: { total: 1, passed: 0, failed: 1 },
    },
  };
  report.cases[0] = {
    ...report.cases[0],
    passed: false,
    error: "Authorization: Bearer top-secret",
  };
  return report;
}

test("writeReporterResult emits redacted, self-contained html", () => {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let stdout = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;

  try {
    writeReporterResult("html", makeFailedReport());
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.match(stdout, /^<!doctype html>/i);
  assert.equal(/<script/i.test(stdout), false);
  assert.equal(/(href|src)\s*=\s*["']https?:\/\//i.test(stdout), false);
  assert.equal(stdout.includes("top-secret"), false);
  assert.match(stdout, /Authorization: \[REDACTED\]/);
});

test("writeReporterArtifact writes redacted html atomically", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-reporting-"));
  const artifactPath = path.join(directory, "report.html");

  const writtenPath = await writeReporterArtifact(
    artifactPath,
    "html",
    makeFailedReport()
  );
  const raw = await readFile(writtenPath, "utf8");

  assert.match(raw, /^<!doctype html>/i);
  assert.match(raw, /Authorization: \[REDACTED\]/);
  assert.equal(raw.includes("top-secret"), false);
  assert.deepEqual(await readdir(directory), ["report.html"]);
});
