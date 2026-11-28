import { describe, expect, it, vi } from "vitest";
import { toolCatalogVersion } from "../session-mcp-config";

// The lane configuration is the same on every turn, so the tool-catalog
// version is what tells a runtime its server's tools changed.

const manager = (tools: Array<Record<string, unknown>>) => ({
  listTools: vi.fn(async () => ({ tools })),
});

describe("toolCatalogVersion", () => {
  const a = { name: "a", description: "first", inputSchema: { type: "object" } };
  const b = { name: "b", inputSchema: { type: "object" } };

  it("is the same for the same tools in any order, and short", async () => {
    const one = await toolCatalogVersion(manager([a, b]) as never, "srv");
    const two = await toolCatalogVersion(manager([b, a]) as never, "srv");
    expect(one).toMatch(/^[a-f0-9]{16}$/);
    expect(two).toBe(one);
  });

  it("changes with a tool's description or input schema, not only its name", async () => {
    const base = await toolCatalogVersion(manager([a]) as never, "srv");
    const described = await toolCatalogVersion(
      manager([{ ...a, description: "changed" }]) as never,
      "srv",
    );
    const reshaped = await toolCatalogVersion(
      manager([{ ...a, inputSchema: { type: "object", required: ["x"] } }]) as never,
      "srv",
    );
    expect(described).not.toBe(base);
    expect(reshaped).not.toBe(base);
  });

  it("is undefined when the server cannot list its tools", async () => {
    const failing = {
      listTools: vi.fn(async () => {
        throw new Error("offline");
      }),
    };
    expect(await toolCatalogVersion(failing as never, "srv")).toBeUndefined();
  });
});
