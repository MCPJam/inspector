import { buildServerDiffReport, diffServerSnapshots } from "../src/server-diff";

function makeSnapshot(
  overrides: Partial<{
    tools: unknown[];
    toolsMetadata: Record<string, unknown>;
    resources: unknown[];
    resourceTemplates: unknown[];
    prompts: unknown[];
    initInfo: unknown;
    capabilities: unknown;
  }> = {}
) {
  return {
    target: "https://example.com/mcp",
    initInfo: null,
    capabilities: null,
    tools: [],
    toolsMetadata: {},
    resources: [],
    resourceTemplates: [],
    prompts: [],
    ...overrides,
  };
}

describe("diffServerSnapshots", () => {
  it("passes when snapshots are identical", () => {
    const left = makeSnapshot({
      tools: [{ name: "echo", description: "Echo" }],
    });
    const right = makeSnapshot({
      tools: [{ name: "echo", description: "Echo" }],
    });

    const result = diffServerSnapshots(left, right);

    expect(result.passed).toBe(true);
    expect(result.changes).toEqual([]);
    expect(result.summary.totalChanges).toBe(0);
  });

  it("classifies added tools as non-breaking", () => {
    const result = diffServerSnapshots(
      makeSnapshot(),
      makeSnapshot({
        tools: [{ name: "echo", description: "Echo" }],
      })
    );

    expect(result.passed).toBe(true);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      entityType: "tools",
      entityId: "echo",
      changeType: "added",
      classification: "non_breaking",
    });
  });

  it("classifies removed tools as breaking", () => {
    const result = diffServerSnapshots(
      makeSnapshot({
        tools: [{ name: "echo", description: "Echo" }],
      }),
      makeSnapshot()
    );

    expect(result.passed).toBe(false);
    expect(result.changes[0]).toMatchObject({
      entityType: "tools",
      entityId: "echo",
      changeType: "removed",
      classification: "breaking",
    });
  });

  it("classifies required input additions as breaking", () => {
    const result = diffServerSnapshots(
      makeSnapshot({
        tools: [
          {
            name: "echo",
            inputSchema: {
              type: "object",
              properties: {
                name: { type: "string" },
              },
            },
          },
        ],
      }),
      makeSnapshot({
        tools: [
          {
            name: "echo",
            inputSchema: {
              type: "object",
              properties: {
                name: { type: "string" },
              },
              required: ["name"],
            },
          },
        ],
      })
    );

    expect(result.passed).toBe(false);
    expect(result.changes[0]?.fieldChanges[0]).toMatchObject({
      field: "inputSchema",
      classification: "breaking",
    });
  });

  it("classifies optional input additions as non-breaking", () => {
    const result = diffServerSnapshots(
      makeSnapshot({
        tools: [
          {
            name: "echo",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
        ],
      }),
      makeSnapshot({
        tools: [
          {
            name: "echo",
            inputSchema: {
              type: "object",
              properties: {
                name: { type: "string" },
              },
            },
          },
        ],
      })
    );

    expect(result.passed).toBe(true);
    expect(result.changes[0]?.fieldChanges[0]).toMatchObject({
      field: "inputSchema",
      classification: "non_breaking",
    });
  });

  it("classifies description-only changes as informational", () => {
    const result = diffServerSnapshots(
      makeSnapshot({
        tools: [{ name: "echo", description: "Old" }],
      }),
      makeSnapshot({
        tools: [{ name: "echo", description: "New" }],
      })
    );

    expect(result.passed).toBe(true);
    expect(result.changes[0]).toMatchObject({
      changeType: "modified",
      classification: "informational",
    });
    expect(result.changes[0]?.fieldChanges).toEqual([
      expect.objectContaining({
        field: "description",
        classification: "informational",
      }),
    ]);
  });

  it("classifies metadata-only changes as informational on the owning tool", () => {
    const result = diffServerSnapshots(
      makeSnapshot({
        tools: [{ name: "echo", description: "Echo" }],
        toolsMetadata: { echo: { title: "Old" } },
      }),
      makeSnapshot({
        tools: [{ name: "echo", description: "Echo" }],
        toolsMetadata: { echo: { title: "New" } },
      })
    );

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      entityType: "tools",
      entityId: "echo",
      classification: "informational",
    });
    expect(result.changes[0]?.fieldChanges).toEqual([
      expect.objectContaining({
        field: "metadata",
        classification: "informational",
      }),
    ]);
  });

  it("reports unsupported complex schema diffs as informational", () => {
    const result = diffServerSnapshots(
      makeSnapshot({
        tools: [
          {
            name: "echo",
            inputSchema: {
              oneOf: [{ type: "string" }, { type: "number" }],
            },
          },
        ],
      }),
      makeSnapshot({
        tools: [
          {
            name: "echo",
            inputSchema: {
              oneOf: [{ type: "string" }, { type: "boolean" }],
            },
          },
        ],
      })
    );

    expect(result.changes[0]?.fieldChanges[0]).toMatchObject({
      field: "inputSchema",
      classification: "informational",
    });
  });
});

describe("buildServerDiffReport", () => {
  it("turns diff changes into structured cases", () => {
    const diff = diffServerSnapshots(
      makeSnapshot(),
      makeSnapshot({
        tools: [{ name: "echo", description: "Echo" }],
      })
    );

    const report = buildServerDiffReport(diff, {
      metadata: { comparisonMode: "file-file" },
    });

    expect(report.schemaVersion).toBe(1);
    expect(report.kind).toBe("server-diff");
    expect(report.metadata).toMatchObject({
      comparisonMode: "file-file",
    });
    expect(report.cases).toEqual([
      expect.objectContaining({
        id: "tool:echo",
        category: "tools",
        classification: "non_breaking",
        passed: true,
      }),
    ]);
  });
});
