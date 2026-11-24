import { describe, expect, it } from "vitest";
import { fullCoverage, makeSurface } from "../../../__tests__/fixtures.js";
import { CORE_FEATURES } from "../index.js";
import { declared, feature, isGap, kindOf } from "./helpers.js";

const tool = (fields: Record<string, unknown>) => ({
  name: "search",
  inputSchema: { type: "object" },
  ...fields,
});

describe("tools discovery", () => {
  it("treats an empty tools object as a declaration", () => {
    const surface = makeSurface({ capabilities: { tools: {} } });
    expect(kindOf(declared("tools.capability", surface))).toBe("present");
    expect(declared("tools.list", surface)).toMatchObject({
      kind: "present",
      count: 0,
    });
  });

  it("calls missing tools a gap only when capabilities and the list are complete", () => {
    const complete = makeSurface();
    expect(isGap(declared("tools.capability", complete), complete)).toBe(true);
    expect(isGap(declared("tools.list", complete), complete)).toBe(true);

    const partialList = makeSurface({
      coverage: fullCoverage({ tools: "partial" }),
    });
    expect(isGap(declared("tools.list", partialList), partialList)).toBe(false);
  });

  it("counts titles and description per tool", () => {
    const surface = makeSurface({
      capabilities: { tools: {} },
      tools: [
        tool({ title: "Search" }),
        tool({ name: "fetch", description: "Fetch a page." }),
      ],
    });
    expect(declared("tools.title", surface)).toMatchObject({
      kind: "present",
      count: 1,
      detail: "1 of 2 tools",
    });
    expect(declared("tools.description", surface)).toMatchObject({ count: 1 });
    expect(isGap(declared("tools.icons", surface), surface)).toBe(true);
  });

  it("flags tool names outside the naming guidance without failing them", () => {
    const surface = makeSurface({
      tools: [tool({ name: "search issues" }), tool({})],
    });
    expect(declared("tools.name", surface)).toMatchObject({
      kind: "present",
      detail: "1 of 2 names fall outside the naming guidance.",
    });
  });

  it("keeps a dropped _meta from reading as missing", () => {
    const stripped = makeSurface({
      tools: [tool({})],
      coverage: fullCoverage({ toolMeta: "partial" }),
    });
    expect(isGap(declared("tools.meta", stripped), stripped)).toBe(false);
    const withMeta = makeSurface({ tools: [tool({ _meta: { "acme/x": 1 } })] });
    expect(kindOf(declared("tools.meta", withMeta))).toBe("present");
  });

  it("waits for a notification before trusting listChanged", () => {
    const promised = makeSurface({
      capabilities: { tools: { listChanged: true } },
    });
    expect(kindOf(declared("tools.list-changed", promised))).toBe("unknown");

    const explicitFalse = makeSurface({
      capabilities: { tools: { listChanged: false } },
    });
    expect(
      isGap(declared("tools.list-changed", explicitFalse), explicitFalse)
    ).toBe(true);

    expect(kindOf(declared("tools.list-changed", makeSurface()))).toBe(
      "not-applicable"
    );
    expect(feature("tools.list-changed").assessment.observable).toBe(true);
  });
});

describe("tool annotations and schemas", () => {
  it("counts an explicit false hint as declared", () => {
    const surface = makeSurface({
      tools: [
        tool({ annotations: { readOnlyHint: false } }),
        tool({ name: "b" }),
      ],
    });
    expect(declared("tools.annotations.read-only-hint", surface)).toMatchObject(
      {
        kind: "present",
        count: 1,
        detail: "Set on 1 of 2 tools: 0 true, 1 false.",
      }
    );
    expect(
      isGap(declared("tools.annotations.destructive-hint", surface), surface)
    ).toBe(true);
  });

  it("is not applicable to a server with no tools", () => {
    const empty = makeSurface();
    for (const id of [
      "tools.annotations",
      "tools.annotations.read-only-hint",
      "tools.output-schema",
      "tools.title",
    ]) {
      expect(kindOf(declared(id, empty)), id).toBe("not-applicable");
    }
    const notListed = makeSurface({
      coverage: fullCoverage({ tools: "not-captured" }),
    });
    expect(kindOf(declared("tools.title", notListed))).toBe("absent");
    expect(isGap(declared("tools.title", notListed), notListed)).toBe(false);
  });

  it("does not trust old snapshots for fields they dropped", () => {
    const old = makeSurface({ envelopeVersion: 2, tools: [tool({})] });
    expect(kindOf(declared("tools.title", old))).toBe("unknown");
    expect(kindOf(declared("tools.icons", old))).toBe("unknown");
    expect(kindOf(declared("tools.annotations.title", old))).toBe("unknown");
  });

  it("reads schemas and refuses to judge schemas storage made lossy", () => {
    const surface = makeSurface({
      tools: [
        tool({
          outputSchema: { type: "object" },
          inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: { q: { $ref: "#/$defs/query" } },
          },
        }),
      ],
    });
    expect(kindOf(declared("tools.input-schema", surface))).toBe("present");
    expect(kindOf(declared("tools.output-schema", surface))).toBe("present");
    expect(kindOf(declared("tools.schema-dialect", surface))).toBe("present");
    expect(declared("tools.schema-ref-bounds", surface)).toMatchObject({
      kind: "present",
      count: 1,
    });

    const plain = makeSurface({ tools: [tool({})] });
    expect(kindOf(declared("tools.schema-dialect", plain))).toBe(
      "not-applicable"
    );
    expect(kindOf(declared("tools.schema-ref-bounds", plain))).toBe(
      "not-applicable"
    );
    expect(isGap(declared("tools.output-schema", plain), plain)).toBe(true);

    const lossy = makeSurface({
      tools: [tool({})],
      coverage: fullCoverage({ toolSchemas: "partial" }),
    });
    expect(kindOf(declared("tools.schema-ref-bounds", lossy))).toBe("unknown");
    expect(isGap(declared("tools.output-schema", lossy), lossy)).toBe(false);
    expect(isGap(declared("tools.schema-dialect", lossy), lossy)).toBe(false);

    const remote = makeSurface({
      tools: [tool({ inputSchema: { $ref: "https://example.com/s.json" } })],
    });
    expect(kindOf(declared("tools.schema-ref-bounds", remote))).toBe("unknown");
  });

  it("reads taskSupport forbidden as a declared no", () => {
    const forbidden = makeSurface({
      tools: [tool({ execution: { taskSupport: "forbidden" } })],
    });
    expect(declared("tools.execution.task-support", forbidden)).toMatchObject({
      kind: "absent",
      detail: "Every tool that sets taskSupport sets it to forbidden.",
    });
    const optional = makeSurface({
      tools: [tool({ execution: { taskSupport: "optional" } })],
    });
    expect(kindOf(declared("tools.execution.task-support", optional))).toBe(
      "present"
    );
  });
});

describe("tool results", () => {
  const results = CORE_FEATURES.filter(
    (entry) => entry.family === "tool-results"
  );

  it("is runtime evidence only, never inferred from the declaration", () => {
    for (const entry of results) {
      expect(entry.assessment.declared, entry.id).toBeUndefined();
    }
  });

  it("lets the classifier report every content type", () => {
    const observable = results
      .filter((entry) => entry.assessment.observable)
      .map((entry) => entry.id);
    expect(observable).toEqual(
      expect.arrayContaining([
        "tool-results.text",
        "tool-results.image",
        "tool-results.audio",
        "tool-results.resource-link",
        "tool-results.embedded-resource",
        "tool-results.structured-content",
        "tool-results.is-error",
        "tool-results.result-type",
      ])
    );
  });
});
