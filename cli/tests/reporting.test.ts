import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { StructuredRunReport } from "@mcpjam/sdk";
import {
  parseReporterFormat,
  writeJsonArtifact,
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
  assert.throws(() => parseReporterFormat("html"), /Invalid reporter/);
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
