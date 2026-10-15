import { describe, expect, it } from "vitest";
import {
  parsePluginWorkspaceDescriptor,
  PluginWorkspaceRequestError,
} from "../plugin-workspace";

describe("plugin workspace request boundary", () => {
  it("preserves absence and copies a bounded presentation label", () => {
    expect(parsePluginWorkspaceDescriptor(undefined)).toBeUndefined();
    const input = { version: 1, workspaceId: '["project","host","lane"]' };
    const result = parsePluginWorkspaceDescriptor(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
  });

  it.each([
    null,
    false,
    [],
    "workspace",
    {},
    { version: 2, workspaceId: "workspace" },
    { version: 1, workspaceId: " " },
    { version: 1, workspaceId: "a\u0000b" },
    { version: 1, workspaceId: "é".repeat(2049) },
    { version: 1, workspaceId: "workspace", actorId: "victim" },
    { version: 1, workspaceId: "workspace", bindingId: "grant" },
    { version: 1, workspaceId: "workspace", path: "/personal" },
  ])(
    "rejects malformed, future and authority-bearing descriptors: %j",
    (input) => {
      expect(() => parsePluginWorkspaceDescriptor(input)).toThrow(
        PluginWorkspaceRequestError,
      );
    },
  );
});
