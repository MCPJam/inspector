import { describe, expect, it } from "vitest";
import { runOpenAIProfileChecks } from "../../src/openai-readiness/checks/profile.js";
const stamp = { evaluatedAt: "2026-09-20T00:00:00Z" };
const tool = () => ({
  name: "get_profile",
  _meta: { "openai/profile": true },
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1, pattern: "\\S" },
      name: { type: "string" },
    },
    required: ["id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
});
const status = (
  tools: any[] | undefined,
  id = "declared",
  listing?: { complete: boolean }
) =>
  runOpenAIProfileChecks(tools, stamp, listing).find(
    (f) => f.id === `openai.profile.${id}`
  )?.status;
describe("profile readiness", () => {
  it("accepts optional designation and rejects malformed or ambiguous markers", () => {
    expect(status([])).toBe("not-applicable");
    expect(status([{ ...tool(), _meta: { "openai/profile": false } }])).toBe(
      "not-applicable"
    );
    for (const marker of ["true", 1, null])
      expect(status([{ ...tool(), _meta: { "openai/profile": marker } }])).toBe(
        "violated"
      );
    expect(status([tool(), tool()])).toBe("violated");
    expect(status([tool()])).toBe("satisfied");
  });
  it("never grades a partial or absent listing as supported", () => {
    expect(status(undefined)).toBe("not-evaluated");
    expect(status([tool()], "declared", { complete: false })).toBe(
      "not-evaluated"
    );
  });
  it("requires the profile contract and read-only declaration", () => {
    expect(status([tool()], "output-schema")).toBe("satisfied");
    for (const key of ["additionalProperties", "required"]) {
      const t = tool();
      delete (t.outputSchema as any)[key];
      expect(status([t], "output-schema")).toBe("violated");
    }
    const t = tool();
    delete (t.outputSchema.properties.id as any).pattern;
    expect(status([t], "output-schema")).toBe("violated");
    expect(status([{ ...tool(), annotations: {} }], "read-only")).toBe(
      "violated"
    );
    expect(
      status(
        [{ ...tool(), inputSchema: { type: "object", required: ["user"] } }],
        "input-empty"
      )
    ).toBe("violated");
    expect(
      status([{ ...tool(), name: "delete_profile" }], "description-honesty")
    ).toBe("informational");
    // A malformed input schema is not an empty one.
    for (const inputSchema of [
      { type: "object", properties: null },
      { type: "object", required: null },
      { type: "object", properties: "nope" },
    ])
      expect(status([{ ...tool(), inputSchema }], "input-empty")).toBe(
        "violated"
      );
  });
});
