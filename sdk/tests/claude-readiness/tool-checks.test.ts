/**
 * Tool checks, with the false-positive guards weighted as heavily as the
 * detections.
 *
 * The catch-all rule is the one that can do real damage: a hard failure says
 * "redesign your API", and saying that on a hunch is worse than missing a
 * case. So the demonstrable-verbs tests come in pairs — the enum that proves
 * it, and the near-miss that must NOT.
 */

import type { Tool } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { runClaudeToolChecks } from "../../src/claude-readiness/checks/tools.js";

const STAMP = { evaluatedAt: "2026-08-19T00:00:00.000Z" };

function tool(overrides: Partial<Tool> & { name: string }): Tool {
  return {
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  } as Tool;
}

function statusOf(findings: ReturnType<typeof runClaudeToolChecks>, id: string) {
  return findings.find((finding) => finding.id === id)?.status;
}

const WELL_FORMED = tool({
  name: "list_orders",
  title: "List orders",
  annotations: { readOnlyHint: true },
});

describe("a well-formed tool list", () => {
  it("satisfies every deterministic tool requirement", () => {
    const findings = runClaudeToolChecks([WELL_FORMED], STAMP);
    expect(findings.every((finding) => finding.status === "satisfied")).toBe(true);
  });
});

describe("an absent tool list is not an empty one", () => {
  it("treats a server with no tools as inapplicable", () => {
    // Nothing here can violate a tool requirement, and five satisfied
    // requirements over an empty list would be five statements about nothing.
    const findings = runClaudeToolChecks([], STAMP);
    expect(findings.every((f) => f.status === "not-applicable")).toBe(true);
    expect(findings[0].notEvaluatedReason).toMatch(/advertises no tools/);
  });

  it("treats an uncaptured listing as an untested obligation", () => {
    // Collapsing this into "not applicable" would claim we established
    // something we never looked at, and a lane would read clean on a gap.
    const findings = runClaudeToolChecks(undefined, STAMP);
    expect(findings.every((f) => f.status === "not-evaluated")).toBe(true);
    expect(findings[0].notEvaluatedReason).toMatch(/no tool listing was captured/);
  });
});

describe("name length", () => {
  it("fails a name past 64 characters and names it", () => {
    const findings = runClaudeToolChecks(
      [tool({ ...WELL_FORMED, name: "a".repeat(65) })],
      STAMP,
    );
    const finding = findings.find((f) => f.id === "claude.tools.name-length")!;
    expect(finding.status).toBe("violated");
    expect((finding.details as { tools: string[] }).tools[0]).toHaveLength(65);
  });

  it("accepts exactly 64", () => {
    expect(
      statusOf(
        runClaudeToolChecks(
          [tool({ ...WELL_FORMED, name: "a".repeat(64) })],
          STAMP,
        ),
        "claude.tools.name-length",
      ),
    ).toBe("satisfied");
  });
});

describe("titles", () => {
  it("accepts a title on the tool or on its annotations", () => {
    for (const candidate of [
      tool({ name: "t", title: "T", annotations: { readOnlyHint: true } }),
      tool({ name: "t", annotations: { title: "T", readOnlyHint: true } }),
    ]) {
      expect(
        statusOf(
          runClaudeToolChecks([candidate], STAMP),
          "claude.tools.title-present",
        ),
      ).toBe("satisfied");
    }
  });

  it("prefers the top-level title over the annotation, per MCP precedence", () => {
    expect(
      statusOf(
        runClaudeToolChecks(
          [
            tool({
              name: "t",
              title: "Top level",
              annotations: { title: "   ", readOnlyHint: true },
            }),
          ],
          STAMP,
        ),
        "claude.tools.title-present",
      ),
    ).toBe("satisfied");
  });

  it("treats a whitespace-only title as absent", () => {
    expect(
      statusOf(
        runClaudeToolChecks(
          [tool({ name: "t", title: "   ", annotations: { readOnlyHint: true } })],
          STAMP,
        ),
        "claude.tools.title-present",
      ),
    ).toBe("violated");
  });
});

describe("behavior hints", () => {
  it("requires at least one hint", () => {
    expect(
      statusOf(
        runClaudeToolChecks([tool({ name: "t", title: "T" })], STAMP),
        "claude.tools.behavior-hints-present",
      ),
    ).toBe("violated");
  });

  it("accepts destructiveHint alone", () => {
    expect(
      statusOf(
        runClaudeToolChecks(
          [tool({ name: "t", title: "T", annotations: { destructiveHint: true } })],
          STAMP,
        ),
        "claude.tools.behavior-hints-present",
      ),
    ).toBe("satisfied");
  });

  it("flags a tool that claims to be both read-only and destructive", () => {
    const findings = runClaudeToolChecks(
      [
        tool({
          name: "t",
          title: "T",
          annotations: { readOnlyHint: true, destructiveHint: true },
        }),
      ],
      STAMP,
    );
    // Presence is satisfied — the hints ARE there — and consistency is not.
    // Collapsing the two would let a contradiction pass as "annotated".
    expect(statusOf(findings, "claude.tools.behavior-hints-present")).toBe(
      "satisfied",
    );
    expect(statusOf(findings, "claude.tools.behavior-hints-consistent")).toBe(
      "violated",
    );
  });

  it("does not flag readOnlyHint:true with destructiveHint:false", () => {
    expect(
      statusOf(
        runClaudeToolChecks(
          [
            tool({
              name: "t",
              title: "T",
              annotations: { readOnlyHint: true, destructiveHint: false },
            }),
          ],
          STAMP,
        ),
        "claude.tools.behavior-hints-consistent",
      ),
    ).toBe("satisfied");
  });
});

describe("the catch-all rule fails only on demonstrable verbs", () => {
  it("fails an enum that contains both a safe and an unsafe verb", () => {
    const findings = runClaudeToolChecks(
      [
        tool({
          name: "records",
          title: "Records",
          annotations: { readOnlyHint: false },
          inputSchema: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["list", "get", "delete"] },
            },
          },
        }),
      ],
      STAMP,
    );
    const finding = findings.find(
      (f) => f.id === "claude.tools.no-catch-all-read-write",
    )!;
    expect(finding.status).toBe("violated");
    expect(finding.details).toMatchObject({
      tools: [{ name: "records", parameter: "action" }],
    });
  });

  it("does NOT fail an enum of safe verbs only", () => {
    expect(
      statusOf(
        runClaudeToolChecks(
          [
            tool({
              name: "search",
              title: "Search",
              annotations: { readOnlyHint: true },
              inputSchema: {
                type: "object",
                properties: {
                  mode: { type: "string", enum: ["list", "get", "search"] },
                },
              },
            }),
          ],
          STAMP,
        ),
        "claude.tools.no-catch-all-read-write",
      ),
    ).toBe("satisfied");
  });

  it("does NOT fail a free-string operation parameter — that is an advisory", () => {
    const findings = runClaudeToolChecks(
      [
        tool({
          name: "call",
          title: "Call",
          annotations: { readOnlyHint: false },
          inputSchema: {
            type: "object",
            properties: { method: { type: "string" } },
          },
        }),
      ],
      STAMP,
    );
    // The hard rule stays clean: nothing DEMONSTRATED that this does both.
    expect(statusOf(findings, "claude.tools.no-catch-all-read-write")).toBe(
      "satisfied",
    );
    const advisory = findings.find(
      (f) => f.id === "claude.tools.free-string-operation-parameter",
    )!;
    expect(advisory.status).toBe("violated");
    // …and the advisory can never fail a lane, because it is not dispositive.
    expect(advisory.class).toBe("recommended");
    expect(advisory.lane).toBe("experience-insights");
  });

  it("does not mistake ordinary field names for verbs", () => {
    // `budget` starts with none of the verbs; `deleted_at` and `getaway` are
    // the shapes a sloppy substring match would flag.
    const findings = runClaudeToolChecks(
      [
        tool({
          name: "report",
          title: "Report",
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: "object",
            properties: {
              scope: {
                type: "string",
                enum: ["budget", "deleted_at", "getaway", "posts"],
              },
            },
          },
        }),
      ],
      STAMP,
    );
    expect(statusOf(findings, "claude.tools.no-catch-all-read-write")).toBe(
      "satisfied",
    );
  });

  it("matches camelCase verbs at the start only", () => {
    const findings = runClaudeToolChecks(
      [
        tool({
          name: "records",
          title: "Records",
          annotations: { readOnlyHint: false },
          inputSchema: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["getUser", "deleteUser"] },
            },
          },
        }),
      ],
      STAMP,
    );
    expect(statusOf(findings, "claude.tools.no-catch-all-read-write")).toBe(
      "violated",
    );
  });

  it("ignores a verb that is not at the start of the token", () => {
    // The paired half of the rule above: `getUser` matches because the verb
    // opens the token, so `userGet` must not.
    expect(
      statusOf(
        runClaudeToolChecks(
          [
            tool({
              name: "records",
              title: "Records",
              annotations: { readOnlyHint: true },
              inputSchema: {
                type: "object",
                properties: {
                  op: { type: "string", enum: ["userGet", "softDelete"] },
                },
              },
            }),
          ],
          STAMP,
        ),
        "claude.tools.no-catch-all-read-write",
      ),
    ).toBe("satisfied");
  });

  it("ignores a schema with no properties at all", () => {
    expect(
      statusOf(
        runClaudeToolChecks(
          [
            tool({
              name: "ping",
              title: "Ping",
              annotations: { readOnlyHint: true },
              inputSchema: { type: "object" },
            }),
          ],
          STAMP,
        ),
        "claude.tools.no-catch-all-read-write",
      ),
    ).toBe("satisfied");
  });

  it("does not flag a constrained enum operation parameter as free-string", () => {
    expect(
      statusOf(
        runClaudeToolChecks(
          [
            tool({
              name: "search",
              title: "Search",
              annotations: { readOnlyHint: true },
              inputSchema: {
                type: "object",
                properties: {
                  method: { type: "string", enum: ["list", "search"] },
                },
              },
            }),
          ],
          STAMP,
        ),
        "claude.tools.free-string-operation-parameter",
      ),
    ).toBe("satisfied");
  });
});

describe("every finding is auditable", () => {
  it("carries a source citation, provenance and an engine version", () => {
    for (const finding of runClaudeToolChecks([WELL_FORMED], STAMP)) {
      expect(finding.source.page).toBeTruthy();
      expect(finding.source.section).toBeTruthy();
      expect(finding.provenance).toBe("static");
      expect(finding.intrusiveness).toBe("passive");
      expect(finding.engineVersion).toBeTruthy();
      expect(finding.evaluatedAt).toBe(STAMP.evaluatedAt);
    }
  });
});
