import { describe, expect, it } from "vitest";
import { resolveServerNames } from "../src/server-replay-configs";

describe("reporting server names", () => {
  const configs = [
    { serverId: "amazon", url: "http://localhost:3001/mcp" },
    { serverId: "amazon", command: "node" },
    { serverId: "catalog", command: "node" },
  ];

  it("infers unique IDs without exposing connection details", () => {
    expect(resolveServerNames({}, configs)).toEqual(["amazon", "catalog"]);
  });

  it("preserves explicit names and an explicit empty list", () => {
    expect(resolveServerNames({ serverNames: ["custom"] }, configs)).toEqual([
      "custom",
    ]);
    expect(resolveServerNames({ serverNames: [] }, configs)).toEqual([]);
  });

  it("does not invent a name when none is available", () => {
    expect(resolveServerNames({}, undefined)).toBeUndefined();
    expect(resolveServerNames({}, [])).toBeUndefined();
    expect(
      resolveServerNames({}, [{ serverId: "  ", command: "node" }])
    ).toBeUndefined();
  });
});
