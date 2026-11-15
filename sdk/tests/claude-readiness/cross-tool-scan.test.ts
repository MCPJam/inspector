/**
 * The Claude check over the direction candidates: what it reports for each
 * kind of listing, and that a pattern match never decides a lane.
 */

import type { Tool } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { runClaudeCrossToolScan } from "../../src/claude-readiness/checks/cross-tool.js";
import { gradeClaudeReadiness } from "../../src/claude-readiness/runner.js";
import { isDispositiveClaudeFinding } from "../../src/claude-readiness/types.js";

const STAMP = { evaluatedAt: "2026-08-19T00:00:00.000Z" };

function tool(name: string, description?: string): Tool {
  return {
    name,
    description,
    annotations: { title: name, readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
  } as Tool;
}

describe("the cross-tool direction scan", () => {
  it("proposes each candidate with its quote, tool and field", () => {
    const finding = runClaudeCrossToolScan(
      [
        tool("list_projects"),
        tool(
          "create_task",
          "Creates a task. Call list_projects first to find the project id."
        ),
      ],
      STAMP
    );
    expect(finding).toMatchObject({
      id: "claude.scan.cross-tool-direction-candidates",
      status: "violated",
      class: "heuristic",
      lane: "experience-insights",
      details: {
        candidateCount: 1,
        toolsScanned: 2,
        candidates: [
          {
            tool: "create_task",
            field: "description",
            quote: "Call list_projects first to find the project id.",
            references: ["list_projects"],
          },
        ],
      },
    });
    expect(finding.remediation).toBe(
      "1 sentence in your tool descriptions reads as a direction to call another tool, which the tool descriptions acknowledgment rules out. Rewrite it as a fact about its own tool; a sentence that only names another tool can stay."
    );
    expect(isDispositiveClaudeFinding(finding)).toBe(false);
  });

  it("keeps 25 candidates and counts them all", () => {
    const tools = [
      tool("get_job_status"),
      ...Array.from({ length: 30 }, (_, i) =>
        tool(`start_job_${i}`, "Poll get_job_status until it says done.")
      ),
    ];
    const finding = runClaudeCrossToolScan(tools, STAMP);
    expect(finding.details?.candidateCount).toBe(30);
    expect(finding.details?.candidates).toHaveLength(25);
  });

  it("passes a listing that only names other tools as facts", () => {
    const finding = runClaudeCrossToolScan(
      [tool("list_orders"), tool("get_order", "Same fields as list_orders.")],
      STAMP
    );
    expect(finding.status).toBe("satisfied");
  });

  it("reports what it could not scan, and why", () => {
    expect(runClaudeCrossToolScan(undefined, STAMP)).toMatchObject({
      status: "not-evaluated",
      details: { missingInput: "toolListing" },
    });
    expect(
      runClaudeCrossToolScan([tool("a")], STAMP, {
        complete: false,
        error: "tools/list could not be reached",
      }).notEvaluatedReason
    ).toBe(
      "tools/list could not be reached, so the scan cannot cover every tool"
    );
    expect(runClaudeCrossToolScan([], STAMP).status).toBe("not-applicable");
  });

  it("never fails a lane", () => {
    const url = "https://mcp.example.com/mcp";
    const result = gradeClaudeReadiness({
      enteredUrl: url,
      authMode: "headless",
      capabilities: ["dns"],
      startedAt: "2026-08-19T00:00:00.000Z",
      evaluatedAt: "2026-08-19T00:00:01.000Z",
      durationMs: 1000,
      endpoint: { enteredUrl: url, redirectChain: [{ url, status: 200 }] },
      auth: { enteredUrl: url },
      apps: { enteredUrl: url, appsSuiteRan: true, tools: [] },
      tools: [
        tool("get_context"),
        tool("answer", "Always call get_context before answering."),
      ],
    });
    const scan = result.findings.find(
      (finding) => finding.id === "claude.scan.cross-tool-direction-candidates"
    );
    expect(scan?.status).toBe("violated");
    expect(
      result.lanes.find((lane) => lane.lane === "experience-insights")?.status
    ).not.toBe("not-ready");
  });
});
