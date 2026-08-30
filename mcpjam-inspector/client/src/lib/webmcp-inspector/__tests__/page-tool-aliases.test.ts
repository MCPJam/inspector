import { describe, it, expect } from "vitest";
import { isPageToolAlias } from "@/shared/client-fulfilled-tools";
import { buildPageToolSnapshot, pageToolAlias } from "../page-tool-aliases";
import type { WebMcpToolDescriptor } from "@/shared/webmcp-inspector-protocol";

function tool(
  overrides: Partial<WebMcpToolDescriptor> = {},
): WebMcpToolDescriptor {
  return {
    toolKey: "https://shop.test::add_to_cart",
    name: "add_to_cart",
    origin: "https://shop.test",
    fromSubframe: false,
    description: "Add an item to the cart",
    inputSchema: { type: "object", properties: {} },
    registrationKind: "imperative",
    ...overrides,
  };
}

describe("pageToolAlias", () => {
  it("produces names the server and every model provider accept", () => {
    const alias = pageToolAlias("session-1", "https://shop.test::add_to_cart");
    expect(isPageToolAlias(alias)).toBe(true);
    // The charset Anthropic and Bedrock enforce. A page-authored name like
    // "add to cart!" would fail it, which is why aliases exist at all.
    expect(alias).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it("is stable, so an alias means the same thing on the next turn", () => {
    const first = pageToolAlias("session-1", "https://shop.test::add_to_cart");
    const second = pageToolAlias("session-1", "https://shop.test::add_to_cart");
    expect(first).toBe(second);
  });

  it("separates tools that differ only by session or by key", () => {
    const base = pageToolAlias("session-1", "https://shop.test::add_to_cart");
    expect(
      pageToolAlias("session-2", "https://shop.test::add_to_cart"),
    ).not.toBe(base);
    expect(pageToolAlias("session-1", "https://shop.test::remove")).not.toBe(
      base,
    );
  });

  it("survives page-authored names the charset would reject", () => {
    const alias = pageToolAlias("s", "https://shop.test::add to cart! 🛒");
    expect(isPageToolAlias(alias)).toBe(true);
  });
});

describe("buildPageToolSnapshot", () => {
  it("carries the fields dispatch and display both need", () => {
    const [entry] = buildPageToolSnapshot("session-1", [tool()]);
    expect(entry).toMatchObject({
      sessionId: "session-1",
      toolKey: "https://shop.test::add_to_cart",
      rawName: "add_to_cart",
      origin: "https://shop.test",
      description: "Add an item to the cart",
    });
    expect(isPageToolAlias(entry.alias)).toBe(true);
  });

  it("is empty without a session or without tools", () => {
    expect(buildPageToolSnapshot(undefined, [tool()])).toEqual([]);
    expect(buildPageToolSnapshot("session-1", [])).toEqual([]);
  });

  it("gives every tool a distinct alias", () => {
    const entries = buildPageToolSnapshot("session-1", [
      tool(),
      tool({ toolKey: "https://shop.test::remove", name: "remove" }),
      tool({
        toolKey: "https://other.test::add_to_cart",
        origin: "https://other.test",
        fromSubframe: true,
      }),
    ]);
    // A shared alias would route one tool's calls to another.
    expect(new Set(entries.map((item) => item.alias)).size).toBe(3);
  });

  it("keeps aliases stable as unrelated tools come and go", () => {
    const before = buildPageToolSnapshot("session-1", [tool()]);
    const after = buildPageToolSnapshot("session-1", [
      tool({ toolKey: "https://shop.test::new", name: "new" }),
      tool(),
    ]);
    const original = after.find(
      (item) => item.toolKey === "https://shop.test::add_to_cart",
    );
    expect(original?.alias).toBe(before[0].alias);
  });
});
