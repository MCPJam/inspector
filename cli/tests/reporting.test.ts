import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  EvalRunDecisionSummary,
  StructuredRunReport,
} from "@mcpjam/sdk";
import { formatEvalRunDecisionSummary } from "@mcpjam/sdk";

/**
 * The shared golden corpus — the same file the SDK contract test and the API
 * route test read.
 *
 * The CLI's human, JSON, JUnit and HTML terminals are supposed to be four
 * renderings of ONE object. A summary hand-written here would let the CLI drift
 * away from what the API returns while this file kept passing.
 */
const decisionCorpus = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../sdk/tests/fixtures/eval-run-decision-summary-fixtures.json",
        import.meta.url
      )
    ),
    "utf8"
  )
) as { cases: Array<{ __name: string; expected: EvalRunDecisionSummary }> };

function corpusSummary(name: string): EvalRunDecisionSummary {
  const row = decisionCorpus.cases.find((entry) => entry.__name === name);
  if (!row) throw new Error(`no decision-summary fixture named "${name}"`);
  return row.expected;
}
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
  const summary = corpusSummary("category-without-first-failed-stage");
  assert.equal(
    formatEvalRunDecisionSummary(summary).includes("Failure category: setup"),
    true
  );
  const original = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    if (typeof chunk === "string") output += chunk;
    return true;
  }) as typeof process.stdout.write;
  try {
    writeEvalDecisionSummary("human", summary, process.stdout);
    assert.match(output, /never reached the server's stages/);
    output = "";
    // `--format json` stays ONE document: prose appended to it would make the
    // stream unparseable for the CI callers that read it.
    writeEvalDecisionSummary("json", summary, process.stdout);
    assert.equal(output, "");
  } finally {
    process.stdout.write = original;
  }
});

test("writes decision summaries to the supplied destination", () => {
  const summary = corpusSummary("category-without-first-failed-stage");
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

test("human output labels its counts with the population they count", () => {
  // Under verdict policy v2 the counts are case-execution VARIANTS; on a legacy
  // run they are trials. The same suite reports a different total under each,
  // so a bare number is not a fact.
  assert.match(
    formatEvalRunDecisionSummary(corpusSummary("policyV2-passing")),
    /case variant/
  );
  assert.match(
    formatEvalRunDecisionSummary(corpusSummary("legacy-run-trial-counts")),
    /4\/6 trials passed/
  );
});

test("human output never prints a raw wire enum", () => {
  const text = formatEvalRunDecisionSummary(
    corpusSummary("measured-failure-at-every-stage")
  );
  assert.equal(text.includes("userValue"), false);
  assert.equal(text.includes("argumentMismatch"), false);
  assert.match(text, /First failed stage: User value/);
});

test("human output says an undecided run is undecided, not failed", () => {
  const text = formatEvalRunDecisionSummary(
    corpusSummary("non-terminal-run-is-notEstablished")
  );
  assert.match(text, /no verdict established/);
  assert.equal(text.includes("notEstablished"), false);
  assert.equal(/Decision summary: failed/.test(text), false);
});

test("human output marks a partial diagnostics page as partial", () => {
  assert.match(
    formatEvalRunDecisionSummary(corpusSummary("partial-diagnostics-page")),
    /PARTIAL/
  );
});

test("json, junit and html all carry the same decision", async () => {
  // The parity claim, exercised through the CLI's own writers rather than the
  // SDK renderers: whatever one terminal shows about the verdict, the first
  // failed stage and the next action, the other two show too.
  const summary = corpusSummary("measured-failure-at-every-stage");
  const report: StructuredRunReport = {
    ...makeReport(),
    kind: "eval-run",
    passed: false,
    verdict: "failed",
    decisionSummary: summary,
  };
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-decision-"));

  const jsonPath = await writeReporterArtifact(
    path.join(directory, "report.json"),
    "json-summary",
    report
  );
  const json = JSON.parse(await readFile(jsonPath, "utf8")) as StructuredRunReport;
  // VERBATIM: the canonical object, not a restatement of it.
  assert.deepEqual(json.decisionSummary, summary);

  const junit = await readFile(
    await writeReporterArtifact(
      path.join(directory, "report.xml"),
      "junit-xml",
      report
    ),
    "utf8"
  );
  const html = await readFile(
    await writeReporterArtifact(
      path.join(directory, "report.html"),
      "html",
      report
    ),
    "utf8"
  );

  for (const artifact of [junit, html]) {
    assert.match(artifact, /First failed stage: User value/);
    assert.match(artifact, /review whether the response answered/);
  }
  // JUnit may encode the detail as text, but it may not DROP the chain while
  // the other two show it.
  assert.match(junit, /<system-out>/);
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
