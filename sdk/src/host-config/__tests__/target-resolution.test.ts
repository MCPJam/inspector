import { describe, expect, it } from "vitest";
import {
  clientServerIds,
  resolveClientEnvironment,
} from "../target-resolution.js";

describe("client target resolution", () => {
  it("keeps required-first order and includes optional servers once", () => {
    const config = {
      serverIds: ["required", "shared", "required"],
      optionalServerIds: ["shared", "optional", "optional"],
    };
    expect(clientServerIds(config)).toEqual(["required", "shared", "optional"]);
    expect(config.optionalServerIds).toEqual([
      "shared",
      "optional",
      "optional",
    ]);
  });

  it("handles optional-only and empty clients", () => {
    expect(clientServerIds({ optionalServerIds: ["optional"] })).toEqual([
      "optional",
    ]);
    expect(clientServerIds({})).toEqual([]);
  });

  it("resolves the same client server set through an attached environment", () => {
    const config = { serverIds: ["required"], optionalServerIds: ["optional"] };
    const match = resolveClientEnvironment("client", [
      { id: "other-env", hostId: "other", config: { serverIds: ["other"] } },
      { id: "env", hostId: "client", config },
    ]);
    expect(match.kind).toBe("unique");
    if (match.kind !== "unique") throw new Error("Expected environment");
    expect(match.environment.id).toBe("env");
    expect(clientServerIds(match.environment.config)).toEqual(
      clientServerIds(config)
    );
  });

  it("preserves every candidate when an explicit target is required", () => {
    const environments = [
      { id: "first", hostId: "client" },
      { id: "second", hostId: "client" },
    ];
    expect(resolveClientEnvironment("client", environments)).toEqual({
      kind: "ambiguous",
      environments,
    });
    expect(resolveClientEnvironment("missing", environments)).toEqual({
      kind: "none",
    });
  });
});
