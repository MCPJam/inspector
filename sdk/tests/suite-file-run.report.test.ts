/**
 * The `eval-local-run` report contract: validated metadata, renderer
 * narrowing, one meaning across terminals, and secrets that never reach any
 * of them.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSuiteFileRunner } from "../src/suite-file-run/run-suite-file.js";
import { SuiteFileRunError } from "../src/suite-file-run/errors.js";
import {
  LocalEvalRunReportError,
  buildLocalEvalRunReport,
  formatLocalEvalRunSummary,
  isLocalEvalRunReport,
} from "../src/suite-file-run/report.js";
import {
  renderStructuredRunHtml,
  renderStructuredRunJUnitXml,
  renderStructuredRunJson,
  type StructuredRunReport,
} from "../src/structured-reporting.js";
import {
  servePolicyTargetFixture,
  type PolicyTargetFixture,
} from "./support/policy-target-fixture.js";
import {
  callThenAnswer,
  scriptedModel,
  type ScriptedStep,
} from "./support/scripted-model.js";

let fixture: PolicyTargetFixture;
beforeEach(async () => {
  fixture = await servePolicyTargetFixture();
});
afterEach(async () => {
  await fixture.close();
});

const SUITE = `schemaVersion: "2"
mode: agentWorkflow
reportingMode: standard
suite:
  id: s_report
  name: report
target:
  servers:
    - name: notes
defaults:
  model: anthropic/claude-haiku-4.5
  iterations: 2
  passThreshold: 0.5
  validity: {}
cases:
  - id: c_read
    title: reads the note
    steps:
      - id: s1
        kind: prompt
        prompt: Read note 7
      - id: a1
        kind: assert
        assertion:
          type: toolCalledAtLeastOnce
          toolName: read_note
`;

const PROVIDER_KEY = "sk-ant-api03-SENTINELSENTINELSENTINEL";

async function run(
  script: (
    context: Parameters<Parameters<typeof scriptedModel>[1]>[0]
  ) => ScriptedStep,
  extra = {}
) {
  const { run } = createSuiteFileRunner({
    createLanguageModel: (model) => scriptedModel(model, script) as never,
  });
  return run(SUITE, {
    servers: { notes: { config: { url: fixture.url }, source: ".mcp.json" } },
    inference: { mode: "byok", providerKeys: { anthropic: PROVIDER_KEY } },
    ...extra,
  });
}

const reads = callThenAnswer(() => ({
  toolName: "read_note",
  input: { id: "7" },
}));

describe("the local report", () => {
  it("records provenance, population in case units, the judge it did not run, and upload off", async () => {
    const result = await run(reads);
    const meta = result.report.metadata;
    expect(meta.verdictAuthority).toBe("local-policy-v2");
    expect(meta.population).toEqual({
      unit: "case",
      cases: 1,
      configuredIterations: 2,
      executedIterations: 2,
      notStartedIterations: 0,
    });
    expect(meta.execution.servers).toEqual([
      { name: "notes", source: ".mcp.json", transport: "http" },
    ]);
    // No judge block in the file: the hosted default (advisory) is recorded, not run.
    expect(meta.cases[0]!.judge).toMatchObject({
      run: false,
      skipReason: "localJudgeUnsupported",
    });
    expect(meta.upload).toMatchObject({
      requested: false,
      declaredReportingMode: "standard",
    });
    expect(meta.decision?.cases[0]?.configuredTrials).toBe(2);
    expect(formatLocalEvalRunSummary(result.report)).toContain(
      "LLM judge: configured but not run locally for 1 case(s)"
    );
    const junit = renderStructuredRunJUnitXml(result.report);
    expect(junit).toContain(
      '<property name="mcpjam.judge" value="configured-not-run:1"/>'
    );
    expect(junit).toContain('<property name="mcpjam.unit" value="case"/>');
    expect(renderStructuredRunHtml(result.report)).toContain(
      "configured but not run locally"
    );
  });

  it("uses one decision for every terminal — pass, fail, inconclusive and interrupted", async () => {
    const outcomes = {
      passed: await run(reads),
      failed: await run(
        callThenAnswer(() => ({ toolName: "echo", input: { message: "x" } }))
      ),
      inconclusive: await run(() => ({ error: new Error("provider down") })),
    };
    const controller = new AbortController();
    const interrupted = await run(
      (context) => {
        controller.abort(new Error("stop"));
        return reads(context);
      },
      { signal: controller.signal }
    );
    for (const [verdict, result] of Object.entries(outcomes)) {
      expect(result.verdict).toBe(verdict);
      expect(renderStructuredRunJson(result.report).verdict).toBe(verdict);
      expect(renderStructuredRunJUnitXml(result.report)).toContain(
        `<property name="mcpjam.verdict" value="${verdict}"/>`
      );
      expect(renderStructuredRunHtml(result.report)).toContain(
        `>${verdict}</span>`
      );
    }
    expect(interrupted.verdict).toBe("notEstablished");
    expect(formatLocalEvalRunSummary(interrupted.report)).toContain("PARTIAL");
    expect(renderStructuredRunHtml(interrupted.report)).toContain(
      "not a completed release gate"
    );
    // Inconclusive and interrupted runs carry no fabricated assertion failure.
    for (const result of [outcomes.inconclusive, interrupted]) {
      expect(renderStructuredRunJUnitXml(result.report)).toContain(
        'failures="0"'
      );
    }
  });

  it("never lets a credential reach any output", async () => {
    const result = await run(() => ({
      error: new Error(
        `upstream said Authorization: Bearer ${PROVIDER_KEY} is invalid`
      ),
    }));
    const outputs = [
      JSON.stringify(result),
      JSON.stringify(renderStructuredRunJson(result.report)),
      renderStructuredRunJUnitXml(result.report),
      renderStructuredRunHtml(result.report),
      formatLocalEvalRunSummary(result.report),
    ];
    for (const output of outputs) {
      expect(output).not.toContain(PROVIDER_KEY);
      expect(output).not.toContain(fixture.url);
    }
  });

  it("is only narrowed to the local contract when its metadata validates", async () => {
    const result = await run(reads);
    expect(isLocalEvalRunReport(result.report)).toBe(true);
    const tampered = {
      ...result.report,
      metadata: { ...result.report.metadata, verdictAuthority: "hosted" },
    } as StructuredRunReport;
    expect(isLocalEvalRunReport(tampered)).toBe(false);
    expect(renderStructuredRunHtml(tampered)).not.toContain(
      'class="local-run"'
    );
    expect(renderStructuredRunJUnitXml(tampered)).not.toContain("<properties>");
  });

  it("refuses to build a report that fails its own contract", async () => {
    const result = await run(reads);
    const meta = result.report.metadata;
    expect(() =>
      buildLocalEvalRunReport({
        execution: meta.execution,
        verdict: meta.verdict,
        decision: meta.decision,
        termination: meta.termination,
        complete: meta.complete,
        population: meta.population,
        issues: meta.issues,
        suite: { ...meta.suite, sourceHash: "not-a-digest" },
        selection: meta.selection,
        cases: result.cases,
        toolPolicy: meta.toolPolicy,
        declaredReportingMode: "standard",
        warnings: [],
        durationMs: 1,
      })
    ).toThrow(LocalEvalRunReportError);
  });

  it("leaves hosted report rendering untouched", () => {
    const hosted: StructuredRunReport = {
      schemaVersion: 1,
      kind: "eval-run",
      passed: true,
      verdict: "passed",
      summary: { total: 0, passed: 0, failed: 0, byCategory: {} },
      cases: [],
      durationMs: 0,
      metadata: {},
    };
    expect(renderStructuredRunJUnitXml(hosted)).not.toContain("<properties>");
    expect(renderStructuredRunHtml(hosted)).not.toContain("Local run");
  });
});

describe("value-based scrubbing", () => {
  it("scrubs a provider key quoted in a shape no pattern recognizes", async () => {
    const result = await run(() => ({
      error: new Error(`invalid x-api-key ${PROVIDER_KEY} for this org`),
    }));
    const text = JSON.stringify(result);
    expect(text).not.toContain(PROVIDER_KEY);
    expect(text).toContain("[REDACTED]");
  });

  it("scrubs observed text only — an ordinary-word secret never rewrites identity or a closed vocabulary", async () => {
    // Every header value is a known secret, whatever it looks like. These
    // three are also the case id, a lifecycle status and a tool name.
    const headers = {
      "x-case": "c_read",
      "x-state": "completed",
      "x-tool": "read_note",
    };
    const result = await run(
      callThenAnswer(() => ({
        toolName: "read_note",
        input: { id: "c_read completed" },
      })),
      {
        servers: {
          notes: {
            config: { url: fixture.url, requestInit: { headers } },
            source: ".mcp.json",
          },
        },
      }
    );
    const [testCase] = result.cases;
    expect(testCase!.caseId).toBe("c_read");
    expect(testCase!.state).toBe("completed");
    expect(result.termination).toBe("completed");
    expect(result.verdict).toBe("passed");
    for (const iteration of testCase!.iterations) {
      expect(iteration.status).toBe("completed");
      expect(iteration.toolCalls[0]!.toolName).toBe("read_note");
      // The observed argument that repeats them is still scrubbed.
      expect(iteration.toolCalls[0]!.arguments).toEqual({
        id: "[REDACTED] [REDACTED]",
      });
    }
    expect(result.report.metadata.selection.selected).toEqual(["c_read"]);
    expect(result.report.metadata.cases[0]!.caseId).toBe("c_read");
    // The emitted report is the one its contract validated.
    expect(isLocalEvalRunReport(result.report)).toBe(true);
    expect(renderStructuredRunJUnitXml(result.report)).toContain(
      "<properties>"
    );
  });

  it("scrubs server credentials from refusals", async () => {
    const { run: runner } = createSuiteFileRunner({
      createLanguageModel: (model) => scriptedModel(model, reads) as never,
    });
    const error = await runner(SUITE, {
      servers: {
        notes: {
          config: {
            url: "http://127.0.0.1:9/mcp?token=srv_token_123456",
            requestInit: {
              headers: { "x-server-secret": "hdr_secret_abcdef" },
            },
          },
        },
      },
      inference: { mode: "byok", providerKeys: { anthropic: PROVIDER_KEY } },
      setupTimeoutMs: 2000,
    }).catch((caught: Error) => caught);
    const text = `${error.message} ${JSON.stringify((error as { details?: unknown }).details)}`;
    expect(text).not.toContain("srv_token_123456");
    expect(text).not.toContain("hdr_secret_abcdef");
  });

  it("keeps a refusal's structured identity when a secret value repeats it", async () => {
    const { run: runner } = createSuiteFileRunner({
      createLanguageModel: (model) => scriptedModel(model, reads) as never,
    });
    const error = await runner(SUITE.replace("name: notes", "name: notebook"), {
      servers: {
        notebook: {
          config: {
            url: "http://127.0.0.1:9/mcp",
            requestInit: { headers: { "x-team": "notebook" } },
          },
        },
      },
      inference: { mode: "byok", providerKeys: { anthropic: PROVIDER_KEY } },
      setupTimeoutMs: 2000,
    }).catch((caught: SuiteFileRunError) => caught);
    expect(error).toBeInstanceOf(SuiteFileRunError);
    expect(error.code).toBe("SERVER_CONNECT_FAILED");
    expect(error.details.problems?.[0]?.server).toBe("notebook");
  });
});
