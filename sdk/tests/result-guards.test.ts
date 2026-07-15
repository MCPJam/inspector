import { describe, expect, it } from "vitest";
import {
  assertCallToolResult,
  isCallToolResult,
} from "../src/mcp-client-manager/result-guards.js";

describe("CallToolResult guards", () => {
  it("accepts resource_link content blocks", () => {
    const result = {
      content: [
        {
          type: "resource_link",
          uri: "example://linked-image.png",
          name: "Linked PNG resource",
          description: "A linked PNG resource for example.",
          mimeType: "image/png",
          _meta: { serverId: "server-1" },
        },
      ],
    };

    expect(isCallToolResult(result)).toBe(true);
    expect(assertCallToolResult(result)).toBe(result);
  });

  it("rejects resource_link content blocks without a uri", () => {
    const result = {
      content: [
        {
          type: "resource_link",
          name: "Broken linked resource",
          mimeType: "image/png",
        },
      ],
    };

    expect(isCallToolResult(result)).toBe(false);
    expect(() => assertCallToolResult(result)).toThrow(
      "MCP tool call result was not a valid CallToolResult."
    );
  });

  it("rejects resource_link content blocks with invalid optional fields", () => {
    const result = {
      content: [
        {
          type: "resource_link",
          uri: "example://linked-image.png",
          mimeType: 123,
        },
      ],
    };

    expect(isCallToolResult(result)).toBe(false);
  });
});
