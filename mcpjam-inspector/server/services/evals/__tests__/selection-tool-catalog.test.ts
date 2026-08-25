import { describe, expect, test } from "vitest";
import {
  buildSelectionToolCatalog,
  MAX_SELECTION_TOOL_CATALOG_ENTRIES,
  MAX_TOOL_CATALOG_FIELD_CHARS,
} from "../selection-tool-catalog.js";

describe("buildSelectionToolCatalog", () => {
  test("builds one entry per expected + actual name, in role order", () => {
    const catalog = buildSelectionToolCatalog({
      tools: {
        get_weather: { description: "Look up weather." },
        delete_all_files: { description: "Deletes files." },
      },
      expectedToolNames: ["get_weather"],
      actualToolNames: ["delete_all_files"],
    });
    expect(catalog).toEqual([
      { name: "get_weather", role: "expected", description: "Look up weather." },
      {
        name: "delete_all_files",
        role: "actual",
        description: "Deletes files.",
      },
    ]);
  });

  test("dedupes by (name, role), not by name alone", () => {
    // Same tool named on both sides (a case whose expected tool WAS called,
    // but also unexpectedly again) keeps one entry per role — the two rows
    // answer different questions ("what should have been chosen" vs "what
    // was chosen").
    const catalog = buildSelectionToolCatalog({
      tools: { search: { description: "d" } },
      expectedToolNames: ["search", "search"],
      actualToolNames: ["search"],
    });
    expect(catalog).toEqual([
      { name: "search", role: "expected", description: "d" },
      { name: "search", role: "actual", description: "d" },
    ]);
  });

  test("caps at MAX_SELECTION_TOOL_CATALOG_ENTRIES total", () => {
    const names = Array.from({ length: 10 }, (_, i) => `tool_${i}`);
    const catalog = buildSelectionToolCatalog({
      tools: Object.fromEntries(names.map((n) => [n, {}])),
      expectedToolNames: names,
      actualToolNames: [],
    });
    expect(catalog).toHaveLength(MAX_SELECTION_TOOL_CATALOG_ENTRIES);
  });

  test("interleaves expected/actual so a long expected list never crowds out every actual entry", () => {
    // A 6+-turn case with a distinct expected tool missing per turn: without
    // interleaving, all MAX_SELECTION_TOOL_CATALOG_ENTRIES slots go to
    // `expected` before `actual` (the tool the model actually, wrongly,
    // called — the most load-bearing evidence for D7's judgment) is ever
    // considered.
    const expectedNames = Array.from({ length: 10 }, (_, i) => `expected_${i}`);
    const catalog = buildSelectionToolCatalog({
      tools: {
        ...Object.fromEntries(expectedNames.map((n) => [n, {}])),
        delete_all_files: { description: "the tool actually called" },
      },
      expectedToolNames: expectedNames,
      actualToolNames: ["delete_all_files"],
    });
    expect(catalog).toHaveLength(MAX_SELECTION_TOOL_CATALOG_ENTRIES);
    expect(catalog.some((e) => e.role === "actual")).toBe(true);
    expect(catalog[1]).toEqual({
      name: "delete_all_files",
      role: "actual",
      description: "the tool actually called",
    });
  });

  test("a tool absent from the live registry still gets a name-only entry", () => {
    const catalog = buildSelectionToolCatalog({
      tools: {},
      expectedToolNames: ["ghost_tool"],
      actualToolNames: [],
    });
    expect(catalog).toEqual([{ name: "ghost_tool", role: "expected" }]);
  });

  test("truncates a long description and omits an empty one", () => {
    const long = "x".repeat(MAX_TOOL_CATALOG_FIELD_CHARS + 200);
    const catalog = buildSelectionToolCatalog({
      tools: {
        verbose_tool: { description: long },
        blank_tool: { description: "" },
      },
      expectedToolNames: ["verbose_tool", "blank_tool"],
      actualToolNames: [],
    });
    expect(catalog[0].description).toHaveLength(MAX_TOOL_CATALOG_FIELD_CHARS);
    expect(catalog[0].description?.endsWith("…")).toBe(true);
    expect(catalog[1]).toEqual({ name: "blank_tool", role: "expected" });
  });

  test("summarizes an AI-SDK-wrapped inputSchema via its .jsonSchema field", () => {
    const catalog = buildSelectionToolCatalog({
      tools: {
        get_weather: {
          inputSchema: {
            jsonSchema: { type: "object", properties: { city: { type: "string" } } },
            validate: () => ({ success: true }),
          },
        },
      },
      expectedToolNames: ["get_weather"],
      actualToolNames: [],
    });
    expect(catalog[0].inputSchemaSummary).toBe(
      JSON.stringify({ type: "object", properties: { city: { type: "string" } } })
    );
  });

  test("falls back to summarizing a bare schema-shaped object", () => {
    const catalog = buildSelectionToolCatalog({
      tools: {
        search: { inputSchema: { type: "object", properties: {} } },
      },
      expectedToolNames: ["search"],
      actualToolNames: [],
    });
    expect(catalog[0].inputSchemaSummary).toBe(
      JSON.stringify({ type: "object", properties: {} })
    );
  });

  test("an unresolvable schema (circular) never throws — just omits the summary", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const catalog = buildSelectionToolCatalog({
      tools: { weird_tool: { inputSchema: circular } },
      expectedToolNames: ["weird_tool"],
      actualToolNames: [],
    });
    expect(catalog[0].inputSchemaSummary).toBeUndefined();
  });

  test("empty expected/actual names produce an empty catalog", () => {
    expect(
      buildSelectionToolCatalog({
        tools: {},
        expectedToolNames: [],
        actualToolNames: [],
      })
    ).toEqual([]);
  });
});
