import { lintToolCatalog } from "../src/tool-lints";

function makeTool(overrides: Record<string, unknown> = {}) {
  return {
    name: "create-note",
    description: "Create a note with the given title and body.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Title of the note." },
      },
      required: ["title"],
    },
    ...overrides,
  };
}

describe("lintToolCatalog", () => {
  it("returns no findings for a clean catalog", () => {
    expect(lintToolCatalog([makeTool()])).toEqual([]);
  });

  it("skips malformed entries without throwing", () => {
    expect(
      lintToolCatalog([
        null,
        42,
        {},
        { name: "" },
        { name: "ok-tool", description: "A perfectly fine tool description." },
      ])
    ).toEqual([]);
  });

  it("flags tools with missing or trivial descriptions", () => {
    const findings = lintToolCatalog([
      makeTool({ name: "no-desc", description: undefined }),
      makeTool({ name: "short-desc", description: "Echo." }),
    ]);

    expect(findings.map((finding) => [finding.rule, finding.tools])).toEqual([
      ["missing-description", ["no-desc"]],
      ["missing-description", ["short-desc"]],
    ]);
  });

  it("flags required opaque IDs with no discovery hint", () => {
    const findings = lintToolCatalog([
      makeTool({
        name: "insight-get",
        description: "Retrieve a saved insight.",
        inputSchema: {
          type: "object",
          properties: {
            insightId: { type: "string", description: "The insight ID." },
          },
          required: ["insightId"],
        },
      }),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "unknowable-required-id",
      tools: ["insight-get"],
      param: "insightId",
    });
  });

  it("does not flag required IDs whose prose says where to get them", () => {
    const findings = lintToolCatalog([
      makeTool({
        name: "insight-get",
        description: "Retrieve a saved insight.",
        inputSchema: {
          type: "object",
          properties: {
            insightId: {
              type: "string",
              description: "The insight ID returned by insight-list.",
            },
          },
          required: ["insightId"],
        },
      }),
    ]);

    expect(findings).toEqual([]);
  });

  it("does not treat words merely ending in 'id' as identifiers", () => {
    const findings = lintToolCatalog([
      makeTool({
        name: "layout-set",
        description: "Configure the dashboard layout arrangement.",
        inputSchema: {
          type: "object",
          properties: {
            grid: { type: "string", description: "The grid preset name." },
          },
          required: ["grid"],
        },
      }),
    ]);

    expect(findings).toEqual([]);
  });

  it("flags the same parameter spelled differently across tools", () => {
    const findings = lintToolCatalog([
      makeTool({
        name: "insight-create",
        description: "Create a saved insight from a query definition.",
        inputSchema: {
          type: "object",
          properties: {
            insightId: { type: "string", description: "Existing insight to use as a base template." },
          },
        },
      }),
      makeTool({
        name: "insight-delete",
        description: "Delete a saved insight permanently from the project.",
        inputSchema: {
          type: "object",
          properties: {
            insight_id: { type: "string", description: "Insight to delete, found via insight-list." },
          },
        },
      }),
    ]);

    const naming = findings.filter(
      (finding) => finding.rule === "inconsistent-param-naming"
    );
    expect(naming).toHaveLength(1);
    expect(naming[0]?.tools.sort()).toEqual(["insight-create", "insight-delete"]);
    expect(naming[0]?.message).toContain('"insightId"');
    expect(naming[0]?.message).toContain('"insight_id"');
  });

  it("flags numeric schema constraints the prose never mentions", () => {
    const findings = lintToolCatalog([
      makeTool({
        name: "insight-update",
        description: "Update a saved insight's name and description fields.",
        inputSchema: {
          type: "object",
          properties: {
            summary: {
              type: "string",
              maxLength: 400,
              description: "Description for the saved insight.",
            },
            documented: {
              type: "string",
              maxLength: 400,
              description: "Max 400 characters; longer values are rejected.",
            },
            trivial: { type: "string", minLength: 1, description: "Any text value works." },
          },
        },
      }),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "undocumented-constraint",
      tools: ["insight-update"],
      param: "summary",
    });
    expect(findings[0]?.message).toContain("maxLength 400");
  });

  it("flags list-shaped tools with no limit or pagination parameter", () => {
    const findings = lintToolCatalog([
      makeTool({
        name: "query-llm-traces",
        description: "Query LLM traces captured for the active project.",
        inputSchema: {
          type: "object",
          properties: {
            dateFrom: { type: "string", description: "Start date filter for the query." },
          },
        },
      }),
      makeTool({
        name: "insights-list",
        description: "List saved insights in the current project scope.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Maximum insights to return." },
          },
        },
      }),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "unbounded-list-tool",
      tools: ["query-llm-traces"],
    });
  });

  it("orders findings by rule, then tool name", () => {
    const findings = lintToolCatalog([
      makeTool({
        name: "traces-list",
        description: "List traces captured for the active project window.",
        inputSchema: { type: "object", properties: {} },
      }),
      makeTool({ name: "bare-tool", description: "" }),
    ]);

    expect(findings.map((finding) => finding.rule)).toEqual([
      "missing-description",
      "unbounded-list-tool",
    ]);
  });
});
