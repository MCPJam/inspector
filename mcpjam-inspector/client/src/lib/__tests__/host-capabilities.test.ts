import { describe, it, expect } from "vitest";
import {
  MCP_UI_EXTENSION_ID,
  MCP_UI_RESOURCE_MIME_TYPE,
} from "@mcpjam/sdk/browser";
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

  it("returns true for Le Chat's captured capability-less MCP Apps host", () => {
    expect(hostSupportsWidgetRendering({}, { hostStyle: "mistral" })).toBe(
      true,
    );
  });

  it("does not treat arbitrary hosts with empty capabilities as widget-capable", () => {
    expect(hostSupportsWidgetRendering({}, { hostStyle: "codex" })).toBe(
      false,
    );
  });

  it("keeps Le Chat's exception scoped to the exact empty capability capture", () => {
    expect(
      hostSupportsWidgetRendering({ elicitation: {} }, { hostStyle: "mistral" }),
    ).toBe(false);
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
      hostSupportsWidgetRendering({ extensions: "nope" as unknown as object })
    ).toBe(false);
    expect(
      hostSupportsWidgetRendering({ extensions: null as unknown as object })
    ).toBe(false);
    expect(
      hostSupportsWidgetRendering({ extensions: [] as unknown as object })
    ).toBe(false);
  });

  it("returns false when the extension entry has no mimeTypes (SEP-1865 strictness)", () => {
    // Behavioral change: per SEP-1865, the extension MUST advertise
    // `mimeTypes` including `text/html;profile=mcp-app`. Hand-crafted
    // minimal blobs like `{ extensions: { [id]: {} } }` no longer count.
    // The SDK default ships the correct shape, so default-using hosts
    // (Claude/ChatGPT/MCPJam/Copilot templates) are unaffected.
    const caps = { extensions: { [MCP_UI_EXTENSION_ID]: {} } };
    expect(hostSupportsWidgetRendering(caps)).toBe(false);
  });

  it("returns false when mimeTypes is present but doesn't include the spec mime", () => {
    const caps = {
      extensions: {
        [MCP_UI_EXTENSION_ID]: { mimeTypes: ["application/json"] },
      },
    };
    expect(hostSupportsWidgetRendering(caps)).toBe(false);
  });

  it("returns true when mimeTypes contains the spec mime alongside others", () => {
    const caps = {
      extensions: {
        [MCP_UI_EXTENSION_ID]: {
          mimeTypes: ["application/json", MCP_UI_RESOURCE_MIME_TYPE],
        },
      },
    };
    expect(hostSupportsWidgetRendering(caps)).toBe(true);
  });

  it("returns false when mimeTypes is a non-array", () => {
    const caps = {
      extensions: {
        [MCP_UI_EXTENSION_ID]: { mimeTypes: MCP_UI_RESOURCE_MIME_TYPE },
      },
    };
    expect(hostSupportsWidgetRendering(caps)).toBe(false);
  });

  it("ignores unrelated extensions", () => {
    const caps = {
      extensions: { "vendor/some-other-ext": { enabled: true } },
    };
    expect(hostSupportsWidgetRendering(caps)).toBe(false);
  });
});
