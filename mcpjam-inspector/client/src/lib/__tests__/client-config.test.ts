import { describe, expect, it } from "vitest";
import {
  mergeHeadersCaseInsensitive,
  mergeProjectConnectionHeaders,
} from "../client-config";

describe("mergeHeadersCaseInsensitive (#3453)", () => {
  it("merges multiple header sources with case-insensitive override and preserving surviving casing", () => {
    const merged = mergeHeadersCaseInsensitive(
      { "x-foo": "first", "x-bar": "kept" },
      { "X-Foo": "second", "X-Baz": "third" },
      { "x-baz": "fourth" },
    );

    expect(merged).toEqual({
      "X-Foo": "second",
      "x-bar": "kept",
      "x-baz": "fourth",
    });
  });

  it("handles empty or undefined sources gracefully", () => {
    const merged = mergeHeadersCaseInsensitive(
      undefined,
      { "Content-Type": "application/json" },
      undefined,
    );

    expect(merged).toEqual({ "Content-Type": "application/json" });
  });
});

describe("mergeProjectConnectionHeaders (#3453)", () => {
  it("deduplicates protocol version case-insensitively with server headers taking precedence", () => {
    const merged = mergeProjectConnectionHeaders(
      { "mcp-protocol-version": "2025-11-25" },
      { "MCP-Protocol-Version": "2026-07-28" },
    );

    expect(merged).toEqual({ "MCP-Protocol-Version": "2026-07-28" });
    const headers = new Headers(merged);
    expect(headers.get("mcp-protocol-version")).toBe("2026-07-28");
  });

  it("overrides project header case-insensitively and preserves distinct headers", () => {
    const merged = mergeProjectConnectionHeaders(
      { "x-custom": "from-project", "x-other": "kept" },
      { "X-Custom": "from-server" },
    );

    expect(merged).toEqual({
      "X-Custom": "from-server",
      "x-other": "kept",
    });
  });

  it("deduplicates case collisions within project headers", () => {
    const merged = mergeProjectConnectionHeaders(
      { "x-header": "lower", "X-Header": "upper" },
      undefined,
    );

    expect(merged).toEqual({ "X-Header": "upper" });
    expect(new Headers(merged).get("x-header")).toBe("upper");
  });
});
