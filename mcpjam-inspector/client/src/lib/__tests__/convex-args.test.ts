import { describe, it, expect } from "vitest";
import { stripConvexReservedKeys } from "../convex-args";

describe("stripConvexReservedKeys", () => {
  it("drops $-prefixed and _-prefixed keys at every depth (the crash repro)", () => {
    const tool = {
      name: "get_projects",
      description: "Get projects",
      _meta: { internal: true },
      inputSchema: {
        $schema: "https://json-schema.org/draft-07/schema",
        type: "object",
        $defs: { Foo: { type: "string" } },
        properties: {
          workspace: { type: "string", $ref: "#/$defs/Foo" },
          _hidden: { type: "string" },
        },
        required: ["workspace"],
      },
    };

    const out = stripConvexReservedKeys(tool);

    expect(out).toEqual({
      name: "get_projects",
      description: "Get projects",
      inputSchema: {
        type: "object",
        properties: {
          workspace: { type: "string" },
        },
        required: ["workspace"],
      },
    });
    // No reserved key survives anywhere — i.e. the value is Convex-serializable.
    expect(JSON.stringify(out)).not.toMatch(/"[$_]/);
  });

  it("passes primitives through and recurses into array items", () => {
    expect(stripConvexReservedKeys(5)).toBe(5);
    expect(stripConvexReservedKeys("x")).toBe("x");
    expect(stripConvexReservedKeys(null)).toBeNull();
    expect(
      stripConvexReservedKeys([
        { a: 1, $b: 2 },
        { _c: 3, d: 4 },
      ])
    ).toEqual([{ a: 1 }, { d: 4 }]);
  });

  it("does not mutate the input", () => {
    const input = { keep: 1, $drop: 2 };
    stripConvexReservedKeys(input);
    expect(input).toEqual({ keep: 1, $drop: 2 });
  });
});
