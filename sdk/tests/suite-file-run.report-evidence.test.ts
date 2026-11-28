/**
 * The local report's per-iteration evidence in HTML and JUnit: every case's
 * tool calls, tokens, scorer results and duration, passing cases included,
 * escaped and capped.
 */
import { describe, expect, it } from "vitest";
import {
  renderStructuredRunHtml,
  renderStructuredRunJUnitXml,
  type StructuredRunReport,
} from "../src/structured-reporting.js";
import { ITERATION_EVIDENCE_LIMITS } from "../src/suite-file-run/report-iteration-evidence.js";
import {
  caseRun,
  iterationEvidence,
  localRunReport,
  sampleLocalRunCases,
} from "./support/local-run-report-fixture.js";

/** The `<details>` block of one case in the HTML report. */
function evidenceBlock(html: string, caseId: string): string {
  const start = html.indexOf(
    `<details class="case-evidence">\n  <summary><strong>${caseId}</strong>`
  );
  expect(start).toBeGreaterThanOrEqual(0);
  return html.slice(start, html.indexOf("</details>", start));
}

/** The `<testcase>` element with this name in the JUnit report. */
function testcase(xml: string, name: string): string {
  const start = xml.indexOf(`<testcase name="${name}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  const selfClosing = xml.indexOf("/>", start);
  const open = xml.indexOf(">", start);
  if (selfClosing + 1 === open) return xml.slice(start, open + 1);
  return xml.slice(start, xml.indexOf("</testcase>", start));
}

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

describe("local report iteration evidence — HTML", () => {
  it("shows a passing case's tool calls, tokens, scores and duration behind a collapsed <details>", () => {
    const html = renderStructuredRunHtml(localRunReport(sampleLocalRunCases()));

    expect(html.match(/<details class="case-evidence">/gu)).toHaveLength(3);
    expect(html).not.toContain("<details open");
    // The summary stays on top: the case table and failures come first.
    const table = html.indexOf('class="local-run"');
    const failures = html.indexOf('class="failed-cases"');
    const evidence = html.indexOf('class="local-run-evidence"');
    expect(table).toBeGreaterThan(0);
    expect(failures).toBeGreaterThan(table);
    expect(evidence).toBeGreaterThan(failures);

    const passing = evidenceBlock(html, "c_order_status");
    expect(passing).toContain(
      'Looks up an order and its shipment <span class="note">· passed · 1 iteration · 2 tool calls · 2055 tokens · 4210ms</span>'
    );
    expect(passing).toContain(
      "completed, passed · 4210ms · tokens 1843 input / 212 output / 2055 total"
    );
    expect(passing).toContain("<p>Tool calls (2)</p>");
    expect(passing).toContain("<code>get_order</code>");
    expect(passing).toContain("&quot;orderId&quot;: &quot;ORD-1042&quot;");
    expect(passing).toContain("<code>get_shipment</code>");
    expect(passing).toContain("&quot;carrier&quot;");
    expect(passing).toContain(
      "<tr><td>predicate:toolCalledAtLeastOnce#1</td><td>gating</td><td>scored</td><td>pass</td><td>get_shipment was called 1 time</td></tr>"
    );

    const failing = evidenceBlock(html, "c_refund");
    expect(failing).toContain("· failed · 1 iteration · 1 tool call ·");
    expect(failing).toContain(
      "<td>fail</td><td>create_refund was never called</td>"
    );
  });

  it("escapes hostile tool names, arguments, reasons and errors", () => {
    const report = localRunReport([
      caseRun({
        caseId: "c_hostile",
        title: "<b>title</b>",
        iterations: [
          iterationEvidence({
            toolCalls: [
              {
                toolName: "<img src=x onerror=alert(1)>",
                arguments: { note: '</pre><script>alert("x")</script>' },
              },
              {
                toolName: "echo",
                arguments: {},
                rawArguments: '{"a": "<b>\u0007',
              },
            ],
            scores: [
              {
                scorerId: "predicate:responseContains#0",
                status: "scored",
                passed: true,
                reason: "<iframe src=javascript:alert(1)>",
              },
            ],
          }),
        ],
      }),
      caseRun({
        caseId: "c_errored",
        iterations: [
          iterationEvidence({
            status: "failed",
            taskVerdict: undefined,
            error: "upstream said <script>bad()</script>",
          }),
        ],
      }),
    ]);

    const html = renderStructuredRunHtml(report);
    for (const raw of [
      "<script>",
      "</pre><script>",
      "<img src=x",
      "<iframe",
      "<b>title</b>",
    ]) {
      expect(html).not.toContain(raw);
    }
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain(
      "&lt;/pre&gt;&lt;script&gt;alert(\\&quot;x\\&quot;)&lt;/script&gt;"
    );
    expect(html).toContain("(not a JSON object; shown as the model sent it)");
    expect(html).toContain("&lt;iframe src=javascript:alert(1)&gt;");
    expect(html).toContain(
      "error: upstream said &lt;script&gt;bad()&lt;/script&gt;"
    );

    const xml = renderStructuredRunJUnitXml(report);
    expect(xml).not.toContain("<script>");
    expect(xml).not.toContain("<img");
    expect(xml).toContain("&lt;img src=x onerror=alert(1)&gt;");
    // A control character in what the model sent stays visible but legal.
    expect(xml).not.toContain("\u0007");
    expect(xml).toContain("\\u0007");
  });

  it("caps long arguments, reasons and call lists with a visible note", () => {
    const blob = "x".repeat(5000);
    const emoji = "\u{1F600}".repeat(1500);
    const report = localRunReport([
      caseRun({
        caseId: "c_big",
        iterations: [
          iterationEvidence({
            toolCalls: [
              { toolName: "upload", arguments: { blob } },
              // Two key lengths so one of them puts each cut mid-pair.
              { toolName: "emoji", arguments: { e: emoji } },
              { toolName: "emoji", arguments: { ee: emoji } },
            ],
            scores: [
              {
                scorerId: "predicate:responseContains#0",
                status: "scored",
                passed: false,
                reason: "r".repeat(1500),
              },
            ],
          }),
        ],
      }),
      caseRun({
        caseId: "c_chatty",
        iterations: [
          iterationEvidence({
            toolCalls: Array.from({ length: 30 }, (_, index) => ({
              toolName: "echo",
              arguments: { message: `call ${index + 1}` },
            })),
          }),
        ],
      }),
    ]);
    const { htmlArgumentChars, textArgumentChars, reasonChars } =
      ITERATION_EVIDENCE_LIMITS;
    expect([htmlArgumentChars, textArgumentChars, reasonChars]).toEqual([
      2000, 500, 1000,
    ]);

    const html = renderStructuredRunHtml(report);
    const big = evidenceBlock(html, "c_big");
    const prettyLength = JSON.stringify({ blob }, null, 2).length;
    expect(big).toContain(
      `Arguments truncated: showing the first 2000 of ${prettyLength} characters.`
    );
    expect(big).toContain("x".repeat(1900));
    expect(big).not.toContain("x".repeat(2000));
    expect(big).toContain(
      "(truncated: showing the first 1000 of 1500 characters)"
    );
    expect(big).not.toMatch(LONE_SURROGATE);

    const chatty = evidenceBlock(html, "c_chatty");
    expect(chatty).toContain("<p>Tool calls (30)</p>");
    expect(chatty.match(/<li>/gu)).toHaveLength(25);
    expect(chatty).toContain("call 25");
    expect(chatty).not.toContain("call 26");
    expect(chatty).toContain("5 more tool calls not shown.");

    const xml = renderStructuredRunJUnitXml(report);
    const compactLength = JSON.stringify({ blob }).length;
    expect(xml).toContain(
      `tool call upload {&quot;blob&quot;:&quot;${"x".repeat(textArgumentChars - 9)} … [truncated: showing the first 500 of ${compactLength} characters]`
    );
    expect(xml).not.toMatch(LONE_SURROGATE);
    expect(xml).not.toMatch(/\\ud[89ab][0-9a-f]{2}/u);
    expect(xml).toContain("5 more tool calls not shown");
  });
});

describe("local report iteration evidence — JUnit", () => {
  it("puts each case's evidence in its own <system-out>, passing cases included", () => {
    const xml = renderStructuredRunJUnitXml(
      localRunReport(sampleLocalRunCases())
    );

    const passing = testcase(xml, "Looks up an order and its shipment");
    expect(passing).toContain(
      [
        "<system-out>case c_order_status: passed · 1 iteration · 2 tool calls · 2055 tokens · 4210ms",
        "iteration 1: completed, passed · 4210ms · tokens 1843 input / 212 output / 2055 total",
        "  tool call get_order {&quot;orderId&quot;:&quot;ORD-1042&quot;}",
        "  tool call get_shipment {&quot;orderId&quot;:&quot;ORD-1042&quot;,&quot;include&quot;:[&quot;events&quot;,&quot;carrier&quot;]}",
        "  scorer predicate:toolCalledAtLeastOnce#0 (gating): scored, pass — get_order was called 1 time",
        "  scorer predicate:toolCalledAtLeastOnce#1 (gating): scored, pass — get_shipment was called 1 time</system-out>",
      ].join("\n")
    );

    // A failure keeps its message and body; the evidence follows it.
    const failing = testcase(xml, "Issues a refund for a damaged item");
    expect(failing).toMatch(
      /<failure message="[^"]*create_refund was never called[^"]*">[^<]*<\/failure>\n {6}<system-out>case c_refund: failed/u
    );
    expect(failing).toContain(
      "scorer predicate:toolCalledAtLeastOnce#0 (gating): scored, fail — create_refund was never called"
    );

    // One per case, plus the suite's local summary; the counts are unchanged.
    expect(xml.match(/<system-out>/gu)).toHaveLength(4);
    expect(xml).toContain('tests="3" failures="1"');
  });

  it("leaves a hosted report's test cases as they were", () => {
    const hosted: StructuredRunReport = {
      schemaVersion: 1,
      kind: "eval-run",
      passed: true,
      verdict: "passed",
      summary: { total: 1, passed: 1, failed: 0, byCategory: {} },
      cases: [{ id: "c1", title: "one", category: "eval", passed: true }],
      durationMs: 0,
      metadata: {},
    };
    const xml = renderStructuredRunJUnitXml(hosted);
    expect(xml).toContain(
      '<testcase name="one" classname="mcpjam.eval-run.eval" time="0.000"/>'
    );
    expect(xml).not.toContain("<system-out>");
    const html = renderStructuredRunHtml(hosted);
    expect(html).not.toContain("case-evidence");
  });
});
