/**
 * The experience-insights lane.
 *
 * The property that matters most here is NEGATIVE and is tested first: nothing
 * this module produces can move a verdict. Everything else — the heuristics
 * themselves — is tested for the false accusation it must not make, because a
 * check with no published rule behind it earns its place only by being right
 * about the cases it flags.
 */

import { describe, expect, it } from "vitest";
import type { Tool } from "@modelcontextprotocol/client";
import {
  CLAUDE_EXPERIENCE_BUDGETS,
  runClaudeExperienceChecks,
  type ClaudeBrowserEvidence,
} from "../../src/claude-readiness/checks/experience.js";
import { enforceCapabilityGate } from "../../src/claude-readiness/runner.js";

const STAMP = { evaluatedAt: new Date(0).toISOString() };

function tool(overrides: Partial<Tool> & { name: string }): Tool {
  return {
    name: overrides.name,
    description:
      overrides.description ??
      "Search the issue tracker and return matching issues.",
    inputSchema: overrides.inputSchema ?? { type: "object" },
    ...overrides,
  } as Tool;
}

const find = (findings: ReturnType<typeof runClaudeExperienceChecks>, id: string) =>
  findings.find((finding) => finding.id === id)!;

describe("the lane cannot move a verdict", () => {
  it("emits only advisory classes, whatever it found", () => {
    // The structural guarantee. `decideLaneStatus` reads `required` and
    // `runtime-blocker`; if anything here ever carried one, a heuristic with
    // no published rule behind it could fail somebody's submission.
    const findings = runClaudeExperienceChecks(
      {
        tools: [
          tool({ name: "get_user", description: "get user" }),
          tool({ name: "getUser" }),
        ],
        browser: {
          widgets: [
            { uri: "ui://a", consoleErrors: ["boom"], painted: false },
          ],
        },
      },
      STAMP,
    );
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(["heuristic", "manual-review"], finding.id).toContain(
        finding.class,
      );
      expect(finding.lane).toBe("experience-insights");
    }
  });

  it("cites a policy source on every finding", () => {
    // A grade nobody can check is an opinion. That applies hardest to the
    // findings with the weakest evidence.
    const findings = runClaudeExperienceChecks({ tools: [tool({ name: "a" })] }, STAMP);
    for (const finding of findings) {
      expect(finding.source?.url, finding.id).toBeTruthy();
      expect(finding.engineVersion, finding.id).toBeTruthy();
      expect(finding.evaluatedAt, finding.id).toBe(STAMP.evaluatedAt);
    }
  });
});

describe("tool descriptions", () => {
  it("flags a description that only restates the name", () => {
    const findings = runClaudeExperienceChecks(
      { tools: [tool({ name: "list_issues", description: "list issues" })] },
      STAMP,
    );
    const finding = find(findings, "claude.experience.tool-descriptions-useful");
    expect(finding.status).toBe("violated");
    expect(finding.remediation).toMatch(/list_issues/);
  });

  it("accepts terse but real prose", () => {
    // The check is aimed at placeholders. A short, genuine description that
    // says something the name does not is exactly what good looks like, and
    // flagging it would train people to pad.
    const findings = runClaudeExperienceChecks(
      {
        tools: [
          tool({
            name: "list_issues",
            description: "Returns open issues, newest first, capped at 50.",
          }),
        ],
      },
      STAMP,
    );
    expect(
      find(findings, "claude.experience.tool-descriptions-useful").status,
    ).toBe("satisfied");
  });

  it("treats a missing description as a name-shaped one", () => {
    const findings = runClaudeExperienceChecks(
      { tools: [tool({ name: "do_thing", description: undefined })] },
      STAMP,
    );
    expect(
      find(findings, "claude.experience.tool-descriptions-useful").status,
    ).toBe("violated");
  });
});

describe("tool names", () => {
  it("flags a pair that differs only by case or separator", () => {
    const findings = runClaudeExperienceChecks(
      { tools: [tool({ name: "get_user" }), tool({ name: "getUser" })] },
      STAMP,
    );
    const finding = find(findings, "claude.experience.tool-names-distinct");
    expect(finding.status).toBe("violated");
    expect(finding.remediation).toMatch(/get_user \/ getUser/);
  });

  it("leaves genuinely different names alone", () => {
    // `get_user` and `fetch_user` are two names a reader tells apart. Flagging
    // them would bury the pair that actually collide.
    const findings = runClaudeExperienceChecks(
      { tools: [tool({ name: "get_user" }), tool({ name: "fetch_user" })] },
      STAMP,
    );
    expect(find(findings, "claude.experience.tool-names-distinct").status).toBe(
      "satisfied",
    );
  });
});

describe("tool surface size", () => {
  it("reports a large surface as INFORMATIONAL, never as a failure", () => {
    // Anthropic publishes no ceiling. A connector that genuinely needs sixty
    // tools must not be told it failed something we invented.
    const tools = Array.from(
      { length: CLAUDE_EXPERIENCE_BUDGETS.toolCountSmell + 5 },
      (_, index) => tool({ name: `tool_${index}` }),
    );
    const finding = find(
      runClaudeExperienceChecks({ tools }, STAMP),
      "claude.experience.tool-surface-size",
    );
    expect(finding.status).toBe("informational");
    expect(finding.remediation).toMatch(/selection accuracy falls off/);
    // "about N", not "the limit" — the number is ours, and the wording says so.
    expect(finding.remediation).toMatch(/Beyond about/);
  });

  it("says nothing about an ordinary surface", () => {
    const tools = Array.from({ length: 8 }, (_, index) =>
      tool({ name: `tool_${index}` }),
    );
    expect(
      find(
        runClaudeExperienceChecks({ tools }, STAMP),
        "claude.experience.tool-surface-size",
      ).status,
    ).toBe("satisfied");
  });
});

describe("required parameters", () => {
  it("flags a required string with nothing to go on", () => {
    const findings = runClaudeExperienceChecks(
      {
        tools: [
          tool({
            name: "search",
            inputSchema: {
              type: "object",
              required: ["query"],
              properties: { query: { type: "string" } },
            } as Tool["inputSchema"],
          }),
        ],
      },
      STAMP,
    );
    const finding = find(findings, "claude.experience.required-params-guided");
    expect(finding.status).toBe("violated");
    expect(finding.remediation).toMatch(/search\.query/);
  });

  it("accepts any one of description, enum, format, pattern or example", () => {
    // Each of these gives the model something to go on, so none of them should
    // be flagged. Testing them together is what stops the check from silently
    // depending on only one.
    for (const guide of [
      { description: "The search terms." },
      { enum: ["open", "closed"] },
      { format: "uri" },
      { pattern: "^[a-z]+$" },
      { examples: ["login bug"] },
      { default: "" },
    ]) {
      const findings = runClaudeExperienceChecks(
        {
          tools: [
            tool({
              name: "search",
              inputSchema: {
                type: "object",
                required: ["query"],
                properties: { query: { type: "string", ...guide } },
              } as Tool["inputSchema"],
            }),
          ],
        },
        STAMP,
      );
      expect(
        find(findings, "claude.experience.required-params-guided").status,
        JSON.stringify(guide),
      ).toBe("satisfied");
    }
  });

  it("ignores optional parameters and non-strings", () => {
    // An optional parameter the model omits costs nothing, and a number needs
    // no enum to be guessable.
    const findings = runClaudeExperienceChecks(
      {
        tools: [
          tool({
            name: "search",
            inputSchema: {
              type: "object",
              required: ["limit"],
              properties: {
                limit: { type: "number" },
                cursor: { type: "string" },
              },
            } as Tool["inputSchema"],
          }),
        ],
      },
      STAMP,
    );
    expect(
      find(findings, "claude.experience.required-params-guided").status,
    ).toBe("satisfied");
  });
});

describe("the missing-listing split", () => {
  it("distinguishes 'never captured' from 'there are none'", () => {
    // The same three-way split the required tool checks make. Collapsing
    // either into a pass would be a claim about something nobody looked at.
    const uncaptured = runClaudeExperienceChecks({}, STAMP);
    const described = find(
      uncaptured,
      "claude.experience.tool-descriptions-useful",
    );
    expect(described.status).toBe("not-evaluated");
    expect((described.details as { missingInput?: string }).missingInput).toBe(
      "toolListing",
    );

    const empty = runClaudeExperienceChecks({ tools: [] }, STAMP);
    expect(
      find(empty, "claude.experience.tool-descriptions-useful").status,
    ).toBe("not-applicable");
  });
});

describe("browser quality", () => {
  const widgets = (
    overrides: Partial<NonNullable<ClaudeBrowserEvidence["widgets"]>[number]>[],
  ): ClaudeBrowserEvidence => ({
    widgets: overrides.map((widget, index) => ({
      uri: `ui://widget-${index}`,
      consoleErrors: [],
      ...widget,
    })),
  });

  it("reports itself as not evaluated on a run with no browser", () => {
    // The whole point of defining these before a harness exists: a lane that
    // silently omitted them would report as fully covered. A wire-only run has
    // no browser evidence AT ALL — passing widget evidence here would describe
    // a run that cannot exist.
    const findings = enforceCapabilityGate(
      runClaudeExperienceChecks({ tools: [tool({ name: "a" })] }, STAMP),
      ["dns", "raw-origin"],
    );
    for (const id of [
      "claude.experience.widget-console-clean",
      "claude.experience.widget-fits-narrow-viewport",
      "claude.experience.widget-paints",
    ]) {
      const finding = find(findings, id);
      expect(finding.status, id).toBe("not-evaluated");
      expect(finding.notEvaluatedReason, id).toMatch(/no browser/);
    }
  });

  it("blames the harness, not the connector, when a browser saw nothing", () => {
    // A browser WAS available and still reported nothing. Saying "no browser"
    // there would send a submitter to debug their widget over our problem.
    const findings = enforceCapabilityGate(
      runClaudeExperienceChecks({ browser: {} }, STAMP),
      ["dns", "raw-origin", "browser"],
    );
    const finding = find(findings, "claude.experience.widget-paints");
    expect(finding.status).toBe("not-evaluated");
    expect(finding.notEvaluatedReason).toMatch(/harness reported no rendered/);
  });

  it("grades console noise when a browser did look", () => {
    const findings = runClaudeExperienceChecks(
      { browser: widgets([{ consoleErrors: ["TypeError: x is not a function"] }]) },
      STAMP,
    );
    const finding = find(findings, "claude.experience.widget-console-clean");
    expect(finding.status).toBe("violated");
    expect(finding.remediation).toMatch(/ui:\/\/widget-0/);
  });

  it("bounds the errors it stores from a widget in a loop", () => {
    const finding = find(
      runClaudeExperienceChecks(
        {
          browser: widgets([
            {
              consoleErrors: Array.from({ length: 500 }, (_, i) => `err ${i}`),
            },
          ]),
        },
        STAMP,
      ),
      "claude.experience.widget-console-clean",
    );
    const stored = (
      finding.details as { widgets: { errors: string[] }[] }
    ).widgets[0]!.errors;
    expect(stored).toHaveLength(5);
  });

  it("never reads an unmeasured widget as fitting", () => {
    // A missing measurement is not evidence of fitting. Reporting `satisfied`
    // here would be the coverage lie this whole model exists to prevent.
    const finding = find(
      runClaudeExperienceChecks({ browser: widgets([{}]) }, STAMP),
      "claude.experience.widget-fits-narrow-viewport",
    );
    expect(finding.status).toBe("not-evaluated");
  });

  it("flags a widget wider than the viewport it was rendered in", () => {
    const finding = find(
      runClaudeExperienceChecks(
        {
          browser: widgets([
            { contentWidthPx: 640, viewportWidthPx: 380 },
            { contentWidthPx: 320, viewportWidthPx: 380 },
          ]),
        },
        STAMP,
      ),
      "claude.experience.widget-fits-narrow-viewport",
    );
    expect(finding.status).toBe("violated");
    expect(finding.remediation).toMatch(/ui:\/\/widget-0/);
    expect(finding.remediation).not.toMatch(/ui:\/\/widget-1/);
  });

  it("hands a blank widget to a person rather than calling it broken", () => {
    // A blank frame may be a broken widget or one correctly waiting for data
    // this harness never supplied. `violated` would accuse the submitter of
    // the first when the evidence cannot rule out the second.
    const finding = find(
      runClaudeExperienceChecks(
        { browser: widgets([{ painted: false }]) },
        STAMP,
      ),
      "claude.experience.widget-paints",
    );
    expect(finding.status).toBe("informational");
    expect(finding.class).toBe("manual-review");
    expect(finding.remediation).toMatch(/waiting for data/);
  });

  it("is not applicable to a connector with no widgets at all", () => {
    const findings = runClaudeExperienceChecks(
      { browser: { widgets: [] } },
      STAMP,
    );
    expect(find(findings, "claude.experience.widget-paints").status).toBe(
      "not-applicable",
    );
  });
});
