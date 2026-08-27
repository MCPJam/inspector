import { describe, it, expect } from "vitest";
import {
  buildPageTools,
  validatePageToolEntries,
  PageToolValidationError,
  type PageToolEntry,
} from "../chat-v2-orchestration";

function entry(
  overrides: Partial<PageToolEntry> = {},
): Record<string, unknown> {
  return {
    alias: "page_1a2b3c4d",
    sessionId: "session-1",
    toolKey: "https://shop.test::add_to_cart",
    rawName: "add_to_cart",
    origin: "https://shop.test",
    description: "Add an item to the cart",
    inputSchema: { type: "object", properties: { sku: { type: "string" } } },
    ...overrides,
  };
}

describe("validatePageToolEntries", () => {
  it("accepts a well-formed snapshot", () => {
    const result = validatePageToolEntries([entry()]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      alias: "page_1a2b3c4d",
      toolKey: "https://shop.test::add_to_cart",
      origin: "https://shop.test",
    });
  });

  it("treats absent input as no page tools", () => {
    expect(validatePageToolEntries(undefined)).toEqual([]);
    expect(validatePageToolEntries(null)).toEqual([]);
    expect(validatePageToolEntries([])).toEqual([]);
  });

  it("rejects a malformed alias", () => {
    // The alias is the token the client-fulfilled gates key on, so a name that
    // does not match would be executed server-side against a tool that has no
    // execute.
    expect(() =>
      validatePageToolEntries([entry({ alias: "add_to_cart" })]),
    ).toThrow(PageToolValidationError);
  });

  it("rejects duplicate aliases", () => {
    // Two entries sharing an alias means one tool's calls silently route to
    // the other.
    expect(() => validatePageToolEntries([entry(), entry()])).toThrow(
      /duplicated/,
    );
  });

  it("requires the fields dispatch depends on", () => {
    for (const key of ["sessionId", "toolKey", "rawName", "origin"]) {
      expect(() =>
        validatePageToolEntries([entry({ [key]: "" } as never)]),
      ).toThrow(PageToolValidationError);
    }
  });

  it("bounds every attacker-influenced field", () => {
    // All of this text originates on a third-party page.
    expect(() =>
      validatePageToolEntries(
        Array.from({ length: 65 }, (_, index) =>
          entry({ alias: `page_${index.toString(16).padStart(8, "0")}` }),
        ),
      ),
    ).toThrow(/at most/);
    expect(() =>
      validatePageToolEntries([entry({ description: "x".repeat(513) })]),
    ).toThrow(/description/);
    expect(() =>
      validatePageToolEntries([
        entry({ inputSchema: { blob: "x".repeat(9000) } as never }),
      ]),
    ).toThrow(/exceeds/);
    expect(() =>
      validatePageToolEntries([entry({ origin: "x".repeat(129) })]),
    ).toThrow(/origin/);
  });

  it("rejects a non-array snapshot", () => {
    expect(() => validatePageToolEntries({ alias: "page_1a2b3c4d" })).toThrow(
      /must be an array/,
    );
  });
});

describe("buildPageTools", () => {
  it("keys tools by alias and gates every one for approval", () => {
    const tools = buildPageTools(validatePageToolEntries([entry()]));
    expect(Object.keys(tools)).toEqual(["page_1a2b3c4d"]);
    // Unconditional: a page tool runs code on a third-party site, and nothing
    // the page says about it is evidence.
    expect(
      (tools.page_1a2b3c4d as { needsApproval?: boolean }).needsApproval,
    ).toBe(true);
  });

  it("has no execute, so the browser fulfills the call", () => {
    const tools = buildPageTools(validatePageToolEntries([entry()]));
    expect(
      (tools.page_1a2b3c4d as { execute?: unknown }).execute,
    ).toBeUndefined();
  });

  it("names the origin in the description the model reads", () => {
    const tools = buildPageTools(validatePageToolEntries([entry()]));
    const description = (tools.page_1a2b3c4d as { description: string })
      .description;
    // A model choosing between tools should be able to see whose page each one
    // belongs to, and that page-authored text is not MCPJam's own.
    expect(description).toContain("WebMCP page tool");
    expect(description).toContain("https://shop.test");
    expect(description).toContain("Add an item to the cart");
  });

  it("falls back to the raw tool name when the page gave no description", () => {
    const tools = buildPageTools(
      validatePageToolEntries([entry({ description: undefined })]),
    );
    expect(
      (tools.page_1a2b3c4d as { description: string }).description,
    ).toContain("add_to_cart");
  });

  it("returns nothing when no page tools were advertised", () => {
    expect(buildPageTools(undefined)).toEqual({});
    expect(buildPageTools([])).toEqual({});
  });
});
