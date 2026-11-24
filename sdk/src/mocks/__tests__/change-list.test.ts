import { describe, expect, it } from "vitest";
import { diffMockDefinitions } from "../index.js";
import type { MockDefinition } from "../index.js";

describe("diffMockDefinitions", () => {
  it("is empty for equal definitions, whatever the key order", () => {
    const a: MockDefinition = {
      tools: {
        x: {
          description: "d",
          params: { p: { fixed: 1 }, q: { hidden: true } },
        },
      },
    };
    const b: MockDefinition = {
      tools: {
        x: {
          params: { q: { hidden: true }, p: { fixed: 1 } },
          description: "d",
        },
      },
    };
    expect(diffMockDefinitions(a, b)).toEqual([]);
  });

  it("reports a first version as added entries, server first then tools by name", () => {
    const changes = diffMockDefinitions(undefined, {
      instructions: "Be brief.",
      tools: { b: { description: "B" }, a: { hidden: true } },
    });
    expect(changes.map((c) => [c.target, c.name, c.kind])).toEqual([
      ["server", undefined, "changed"],
      ["tool", "a", "added"],
      ["tool", "b", "added"],
    ]);
    expect(changes[1].summary).toBe('Hid the tool "a"');
  });

  it("says what changed on one tool, field by field", () => {
    const before: MockDefinition = {
      tools: {
        search: { description: "old", params: { limit: { fixed: 5 } } },
      },
    };
    const after: MockDefinition = {
      tools: {
        search: {
          description: "new",
          params: { limit: { fixed: 10 }, lang: { hidden: true } },
          annotations: { destructiveHint: false },
        },
      },
    };
    const [change] = diffMockDefinitions(before, after);
    expect(change.kind).toBe("changed");
    expect(change.details.map((d) => [d.path, d.kind])).toEqual([
      ["annotations.destructiveHint", "added"],
      ["description", "changed"],
      ["params.lang.hidden", "added"],
      ["params.limit.fixed", "changed"],
    ]);
    expect(change.details[1]).toMatchObject({ before: "old", after: "new" });
    expect(change.summary).toContain('Hid the parameter "lang" of "search"');
  });

  it("describes a rename with the old name hidden", () => {
    const changes = diffMockDefinitions(
      { tools: {} },
      {
        tools: {
          find: { answer: { tool: "search" } },
          search: { hidden: true },
        },
      }
    );
    expect(changes.map((c) => c.summary)).toEqual([
      'Pointed "find" at the real tool "search"',
      'Hid the tool "search"',
    ]);
  });

  it("reports a removed entry and a fixed value of null", () => {
    const changes = diffMockDefinitions(
      {
        tools: {
          gone: { description: "x" },
          p: { params: { a: { fixed: null } } },
        },
      },
      { tools: { p: { params: { a: { fixed: null } } } } }
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ name: "gone", kind: "removed" });
  });
});
