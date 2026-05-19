import { describe, it, expect } from "vitest";
import { MCP_UI_EXTENSION_ID } from "@mcpjam/sdk/browser";
import { hostSupportsWidgetRendering } from "../host-capabilities";

describe("hostSupportsWidgetRendering", () => {
  it("returns true when the MCP UI extension is advertised", () => {
    const caps = {
      extensions: {
        [MCP_UI_EXTENSION_ID]: { mimeTypes: ["text/html;profile=mcp-app"] },
      },
    };
    expect(hostSupportsWidgetRendering(caps)).toBe(true);
  });

  it("returns true when the host config is absent (undefined)", () => {
    // Default for legacy surfaces / tests without an activeHost in scope —
    // preserve historical behavior (gate falls back to tool-metadata only).
    expect(hostSupportsWidgetRendering(undefined)).toBe(true);
  });

  it("returns false when extensions is missing", () => {
    expect(hostSupportsWidgetRendering({ elicitation: {} })).toBe(false);
  });

  it("returns false when the UI extension is explicitly stripped (Codex)", () => {
    // Mirrors the Codex template in client-templates.ts:803-810, which
    // REPLACES clientCapabilities (no spread) so the SDK-default UI
    // extension is gone.
    const codex = { elicitation: {} };
    expect(hostSupportsWidgetRendering(codex)).toBe(false);
  });

  it("returns false when extensions is non-object (defensive)", () => {
    expect(
      hostSupportsWidgetRendering({ extensions: "nope" as unknown as object }),
    ).toBe(false);
    expect(
      hostSupportsWidgetRendering({ extensions: null as unknown as object }),
    ).toBe(false);
    expect(
      hostSupportsWidgetRendering({ extensions: [] as unknown as object }),
    ).toBe(false);
  });

  it("returns true even when the extension entry is an empty object", () => {
    // Presence of the key is the contract; value is opaque here. SDK
    // ships `{ mimeTypes: [...] }` but profiles MAY emit a bare `{}`.
    const caps = { extensions: { [MCP_UI_EXTENSION_ID]: {} } };
    expect(hostSupportsWidgetRendering(caps)).toBe(true);
  });

  it("ignores unrelated extensions", () => {
    const caps = {
      extensions: { "vendor/some-other-ext": { enabled: true } },
    };
    expect(hostSupportsWidgetRendering(caps)).toBe(false);
  });
});
