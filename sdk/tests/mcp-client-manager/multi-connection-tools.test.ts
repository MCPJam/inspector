import { asSchema, jsonSchema } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  mergeConnectionToolsets,
  type McpToolConnection,
} from "../../src/mcp-client-manager/multi-connection-tools.js";
import {
  connectionKey,
  parseConnectionKey,
} from "../../src/mcp-client-manager/connection-key.js";
const a: McpToolConnection = {
  serverId: "server",
  connectionId: "a".repeat(32),
  key: "server",
  label: "Acme",
  isDefault: true,
};
const b = {
  ...a,
  connectionId: "b".repeat(32),
  key: "server#" + "b".repeat(32),
  label: "Side",
  isDefault: false,
};
const snapshot = new Map([
  [a.connectionId, a.key],
  [b.connectionId, b.key],
]);
function fixture(schema?: any) {
  const tool = (account: string) => ({
    inputSchema: jsonSchema({
      type: "object",
      properties: { query: { type: "string" } },
    }),
    execute: vi.fn(async () => ({
      content: [{ type: "resource_link", uri: "resource://same" }],
    })),
    toModelOutput: vi.fn(async () => ({
      type: "text",
      value: `resource://same belongs to ${account}`,
    })),
  });
  const at = tool("A"),
    bt = tool("B");
  if (schema) bt.inputSchema = jsonSchema(schema);
  const perKey = { [a.key]: { search: at }, [b.key]: { search: bt } };
  const onRoute = vi.fn();
  return {
    at,
    bt,
    perKey,
    onRoute,
    merged: mergeConnectionToolsets(
      perKey as any,
      { server: [a, b] },
      { snapshot, onRoute }
    ),
  };
}
const opts = { toolCallId: "call", messages: [] };
describe("multi-connection tools", () => {
  it("uses B for execution and output conversion of the same resource URI", async () => {
    const { merged, at, bt, onRoute } = fixture();
    const input = { query: "hello", link_id: b.connectionId };
    const output = await merged.search.execute!(input, opts);
    expect(bt.execute).toHaveBeenCalledWith({ query: "hello" }, opts);
    expect(at.execute).not.toHaveBeenCalled();
    expect(
      await merged.search.toModelOutput!({ toolCallId: "call", input, output })
    ).toEqual({ type: "text", value: "resource://same belongs to B" });
    expect(at.toModelOutput).not.toHaveBeenCalled();
    expect(onRoute).toHaveBeenCalledWith("call", b);
  });
  it("rejects missing or foreign selectors before any invocation", async () => {
    const { merged, at, bt } = fixture();
    for (const input of [{}, { link_id: "foreign" }])
      expect(await merged.search.execute!(input, opts)).toMatchObject({
        isError: true,
      });
    expect(at.execute).not.toHaveBeenCalled();
    expect(bt.execute).not.toHaveBeenCalled();
  });
  it.each([
    { type: "object", properties: { link_id: { type: "string" } } },
    { type: "object", properties: { other: { type: "boolean" } } },
  ])("creates variants for collisions or differing schemas", async (schema) => {
    const { merged, bt } = fixture(schema);
    expect(merged.search).toBeUndefined();
    expect(Object.keys(merged)).toHaveLength(2);
    const variant = Object.keys(merged).find((k) => k.endsWith("__side"))!;
    await merged[variant].execute!({ link_id: "upstream" }, opts);
    expect(bt.execute).toHaveBeenCalledWith({ link_id: "upstream" }, opts);
  });
  it("keeps long tool names distinguishable and inside the name limit", () => {
    // Both names share their first 20 characters. Truncating the TOOL name to
    // make room for the account slug collapsed them into one variant plus a
    // "-2" suffix, leaving the model no way to tell the two tools apart.
    const names = [
      "search_customer_records_by_email_address",
      "search_customer_records_by_phone_number",
    ];
    const long = [
      { ...a, label: "Acme Corporation Production Workspace" },
      { ...b, label: "Side Project Personal Sandbox" },
    ];
    const set = (schema: any) =>
      Object.fromEntries(
        names.map((name) => [
          name,
          { inputSchema: jsonSchema(schema), execute: vi.fn() },
        ])
      );
    const keys = Object.keys(
      mergeConnectionToolsets(
        {
          [a.key]: set({ type: "object", properties: {} }),
          [b.key]: set({
            type: "object",
            properties: { other: { type: "boolean" } },
          }),
        } as any,
        { server: long },
        { snapshot }
      )
    );
    expect(new Set(keys).size).toBe(4);
    for (const key of keys) expect(key.length).toBeLessThanOrEqual(64);
    for (const name of names)
      expect(keys.filter((key) => key.startsWith(name.slice(0, 40)))).toHaveLength(2);
  });
  it("preserves single-connection tools and exposes tools only on B", () => {
    const { perKey } = fixture();
    const lone = mergeConnectionToolsets(
      { [a.key]: perKey[a.key] } as any,
      { server: [a] },
      { snapshot }
    ).search as any;
    expect(lone.execute).toBe(perKey[a.key].search.execute);
    // Even on the bare default key the tool names its connection, so a
    // continuation saved against it can be bound to that credential.
    expect(lone._connectionForCall("any")).toBe(a);
    expect(lone._connectionForInput({})).toBe(a);
    const tools = mergeConnectionToolsets(
      { [a.key]: {}, [b.key]: perKey[b.key] } as any,
      { server: [a, b] },
      { snapshot }
    );
    expect(
      (asSchema(tools.search.inputSchema).jsonSchema as any).properties.link_id
        .enum
    ).toEqual([b.connectionId]);
  });
  it("keeps deduplicated account slugs inside the budget", () => {
    const shared = "Acme Corporation Production Workspace";
    const many = Array.from({ length: 11 }, (_unused, index) => ({
      ...a,
      connectionId: String(index).padStart(32, "c"),
      key: `server#${String(index).padStart(32, "c")}`,
      label: shared,
      isDefault: false,
    }));
    const keys = Object.keys(
      mergeConnectionToolsets(
        Object.fromEntries(
          many.map((c, index) => [
            c.key,
            {
              search_customer_records_by_email_address: {
                // One differing schema forces the whole name onto the variant
                // path, which is where the slugs are used.
                inputSchema: jsonSchema({
                  type: "object",
                  properties: index === 0 ? {} : { q: { type: "string" } },
                }),
                execute: vi.fn(),
              },
            },
          ])
        ) as any,
        { server: many },
        {
          snapshot: new Map(many.map((c) => [c.connectionId, c.key])),
        }
      )
    );
    expect(new Set(keys).size).toBe(11);
    for (const key of keys) expect(key.length).toBeLessThanOrEqual(64);
  });
  it("round-trips qualified keys without parsing user-typed hashes", () => {
    expect(connectionKey("name#hash", b.connectionId, true)).toBe("name#hash");
    expect(
      parseConnectionKey(connectionKey("name#hash", b.connectionId))
    ).toEqual({ serverKey: "name#hash", connectionId: b.connectionId });
    expect(parseConnectionKey("name#hash")).toEqual({ serverKey: "name#hash" });
  });
});
