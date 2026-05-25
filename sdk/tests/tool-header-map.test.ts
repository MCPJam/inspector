import { describe, expect, test } from "vitest";
import {
  ToolHeaderMap,
  parseToolsForHeaderMap,
  encodeHeaderValue,
  assertNotPaginated,
  type ParsedTool,
} from "../src/mcp-client-manager/tool-header-map.js";
import { PaginatedToolHeaderDiscoveryUnsupported } from "../src/mcp-client-manager/managed-mcp-client.js";

describe("parseToolsForHeaderMap — annotation validation", () => {
  const tool = (
    name: string,
    properties: Record<string, unknown>,
  ): ParsedTool => ({ name, inputSchema: { properties } });

  test("plain tool yields an empty header map", () => {
    const result = parseToolsForHeaderMap([
      tool("echo", { value: { type: "string" } }),
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.entries.get("echo")?.paramToHeader.size).toBe(0);
  });

  test("valid x-mcp-header is captured", () => {
    const result = parseToolsForHeaderMap([
      tool("rl", { region: { type: "string", "x-mcp-header": "Region" } }),
    ]);
    expect(result.entries.get("rl")?.paramToHeader.get("region")).toBe("Region");
  });

  test("excludes tool with empty annotation", () => {
    const result = parseToolsForHeaderMap([
      tool("bad", { region: { type: "string", "x-mcp-header": "" } }),
    ]);
    expect(result.entries.has("bad")).toBe(false);
    expect(result.warnings.join("\n")).toMatch(/must not be empty/);
  });

  test("excludes tool with non-ASCII annotation", () => {
    const result = parseToolsForHeaderMap([
      tool("bad", { r: { type: "string", "x-mcp-header": "Régión" } }),
    ]);
    expect(result.entries.has("bad")).toBe(false);
  });

  test("excludes tool with whitespace in annotation", () => {
    const result = parseToolsForHeaderMap([
      tool("bad", { r: { type: "string", "x-mcp-header": "My Region" } }),
    ]);
    expect(result.entries.has("bad")).toBe(false);
  });

  test("excludes tool with duplicate header names (case-insensitive)", () => {
    const result = parseToolsForHeaderMap([
      tool("bad", {
        a: { type: "string", "x-mcp-header": "Region" },
        b: { type: "string", "x-mcp-header": "REGION" },
      }),
    ]);
    expect(result.entries.has("bad")).toBe(false);
  });

  test("excludes tool with non-string annotation type", () => {
    const result = parseToolsForHeaderMap([
      tool("bad", { r: { type: "string", "x-mcp-header": 42 } }),
    ]);
    expect(result.entries.has("bad")).toBe(false);
  });

  // SEP-2243: x-mcp-header is only valid on primitive types
  // (string / number / boolean). Per spec, clients MUST exclude
  // tools that violate this from `tools/list`.
  test("excludes tool with x-mcp-header on object schema", () => {
    const result = parseToolsForHeaderMap([
      tool("bad", {
        meta: { type: "object", "x-mcp-header": "Meta" },
      }),
    ]);
    expect(result.entries.has("bad")).toBe(false);
    expect(result.warnings.join("\n")).toMatch(/non-primitive/);
    expect(result.warnings.join("\n")).toMatch(/type: object/);
  });

  test("excludes tool with x-mcp-header on array schema", () => {
    const result = parseToolsForHeaderMap([
      tool("bad", {
        tags: { type: "array", "x-mcp-header": "Tags" },
      }),
    ]);
    expect(result.entries.has("bad")).toBe(false);
    expect(result.warnings.join("\n")).toMatch(/non-primitive/);
  });

  test("excludes tool with x-mcp-header on null schema", () => {
    const result = parseToolsForHeaderMap([
      tool("bad", {
        nothing: { type: "null", "x-mcp-header": "Nothing" },
      }),
    ]);
    expect(result.entries.has("bad")).toBe(false);
  });

  test("accepts x-mcp-header on number + boolean primitives", () => {
    const result = parseToolsForHeaderMap([
      tool("nums", {
        count: { type: "number", "x-mcp-header": "Count" },
        enabled: { type: "boolean", "x-mcp-header": "Enabled" },
      }),
    ]);
    expect(result.entries.has("nums")).toBe(true);
    expect(result.entries.get("nums")?.paramToHeader.get("count")).toBe("Count");
    expect(result.entries.get("nums")?.paramToHeader.get("enabled")).toBe(
      "Enabled",
    );
  });

  // Untyped schemas keep the runtime-check fallback — declaration-time
  // exclusion is only mandated when the schema explicitly declares a
  // non-primitive. Untyped sees the existing primitive-check at
  // `deriveHeaders` runtime instead.
  test("accepts x-mcp-header on schema without explicit type", () => {
    const result = parseToolsForHeaderMap([
      tool("untyped", {
        region: { "x-mcp-header": "Region" } as Record<string, unknown>,
      }),
    ]);
    expect(result.entries.has("untyped")).toBe(true);
  });
});

describe("ToolHeaderMap.deriveHeaders — mirror semantics (not lift)", () => {
  const buildMap = () => {
    const map = new ToolHeaderMap();
    const parsed = parseToolsForHeaderMap([
      {
        name: "rl",
        inputSchema: {
          properties: { region: { type: "string", "x-mcp-header": "Region" } },
        },
      },
    ]);
    map.update(parsed.entries, 60_000);
    return map;
  };

  test("emits header AND keeps the body slot intact (SEP-2243 mirror)", () => {
    const map = buildMap();
    const { headers, bodyArguments } = map.deriveHeaders("rl", {
      value: "hi",
      region: "us-west1",
    });
    expect(headers["Mcp-Param-Region"]).toBe("us-west1");
    // Mirror, not lift: the annotated key MUST remain on the body so
    // the server's strict equality check passes.
    expect(bodyArguments).toEqual({ value: "hi", region: "us-west1" });
  });

  test("null / undefined values omit the header but keep the body", () => {
    const map = buildMap();
    const { headers, bodyArguments } = map.deriveHeaders("rl", {
      value: "hi",
      region: null,
    });
    expect(headers).toEqual({});
    expect(bodyArguments).toEqual({ value: "hi", region: null });
  });

  test("non-primitive values omit the header but keep the body", () => {
    const map = buildMap();
    const obj = { nested: "x" };
    const { headers, bodyArguments } = map.deriveHeaders("rl", {
      region: obj,
    });
    expect(headers).toEqual({});
    expect(bodyArguments).toEqual({ region: obj });
  });

  test("returns args unchanged for tools with no annotations", () => {
    const map = new ToolHeaderMap();
    const parsed = parseToolsForHeaderMap([
      { name: "echo", inputSchema: { properties: { value: { type: "string" } } } },
    ]);
    map.update(parsed.entries, 60_000);
    const { headers, bodyArguments } = map.deriveHeaders("echo", { value: "x" });
    expect(headers).toEqual({});
    expect(bodyArguments).toEqual({ value: "x" });
  });
});

describe("ToolHeaderMap.isFresh — TTL semantics (SEP-2549)", () => {
  test("never-populated map is not fresh", () => {
    const map = new ToolHeaderMap();
    expect(map.isFresh()).toBe(false);
  });

  test("missing ttlMs is treated as stale-on-arrival", () => {
    const map = new ToolHeaderMap();
    map.update(new Map(), undefined);
    expect(map.isFresh()).toBe(false);
  });

  test("ttlMs: 0 is stale-on-arrival", () => {
    const map = new ToolHeaderMap();
    map.update(new Map(), 0);
    expect(map.isFresh()).toBe(false);
  });

  test("negative ttlMs is stale-on-arrival", () => {
    const map = new ToolHeaderMap();
    map.update(new Map(), -1);
    expect(map.isFresh()).toBe(false);
  });

  test("positive ttlMs is fresh until expiry", () => {
    const map = new ToolHeaderMap();
    const now = 1_000_000;
    map.update(new Map(), 1000, now);
    expect(map.isFresh(now + 500)).toBe(true);
    expect(map.isFresh(now + 1500)).toBe(false);
  });

  test("close clears freshness", () => {
    const map = new ToolHeaderMap();
    map.update(new Map(), 60_000);
    map.clear();
    expect(map.isFresh()).toBe(false);
  });
});

describe("encodeHeaderValue — SEP-2243 base64 envelope", () => {
  test("plain ASCII passes through unchanged", () => {
    expect(encodeHeaderValue("us-west1")).toBe("us-west1");
    expect(encodeHeaderValue("token-abc123_.~")).toBe("token-abc123_.~");
  });

  test("non-ASCII wraps as =?base64?...?= and decodes back", () => {
    const wrapped = encodeHeaderValue("Région");
    expect(wrapped).toMatch(/^=\?base64\?.+\?=$/);
    const m = wrapped.match(/^=\?base64\?([^?]*)\?=$/);
    expect(Buffer.from(m![1], "base64").toString("utf-8")).toBe("Région");
  });

  test("leading or trailing whitespace forces base64 envelope", () => {
    expect(encodeHeaderValue(" foo")).toMatch(/^=\?base64\?/);
    expect(encodeHeaderValue("foo ")).toMatch(/^=\?base64\?/);
    expect(encodeHeaderValue("\tfoo")).toMatch(/^=\?base64\?/);
  });

  test("control chars force base64 envelope", () => {
    expect(encodeHeaderValue("foo\nbar")).toMatch(/^=\?base64\?/);
  });

  test("empty string passes through", () => {
    expect(encodeHeaderValue("")).toBe("");
  });
});

describe("assertNotPaginated", () => {
  test("undefined / null nextCursor is OK", () => {
    expect(() => assertNotPaginated(undefined)).not.toThrow();
    expect(() => assertNotPaginated({ nextCursor: null })).not.toThrow();
    expect(() => assertNotPaginated({ nextCursor: undefined })).not.toThrow();
  });

  test("present nextCursor throws PaginatedToolHeaderDiscoveryUnsupported", () => {
    expect(() => assertNotPaginated({ nextCursor: "abc" })).toThrow(
      PaginatedToolHeaderDiscoveryUnsupported,
    );
  });
});
