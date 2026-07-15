import { describe, expect, it } from "vitest";
import { emptyHostConfigInputV2 } from "@/lib/client-config-v2";
import { XAA_MCP_EXTENSION } from "@mcpjam/sdk/browser";
import {
  hasEmaExtension,
  withEmaExtension,
  withoutEmaExtension,
} from "../ProtocolTab";

const UI_EXTENSION = "io.modelcontextprotocol/ui";

function extensionsOf(caps: Record<string, unknown> | undefined) {
  return (caps as { extensions?: Record<string, unknown> } | undefined)
    ?.extensions;
}

describe("ProtocolTab EMA extension helpers", () => {
  it("round-trips on/off while preserving sibling extensions", () => {
    const base = emptyHostConfigInputV2();
    expect(hasEmaExtension(base.clientCapabilities)).toBe(false);

    const on = withEmaExtension(base);
    expect(hasEmaExtension(on.clientCapabilities)).toBe(true);
    expect(extensionsOf(on.clientCapabilities)?.[XAA_MCP_EXTENSION]).toEqual(
      {}
    );
    // The default MCP UI extension rides along untouched.
    expect(extensionsOf(on.clientCapabilities)?.[UI_EXTENSION]).toBeDefined();

    const off = withoutEmaExtension(on);
    expect(hasEmaExtension(off.clientCapabilities)).toBe(false);
    expect(extensionsOf(off.clientCapabilities)?.[UI_EXTENSION]).toBeDefined();
    // Removing EMA restores the original shape byte-for-byte.
    expect(off.clientCapabilities).toEqual(base.clientCapabilities);
  });

  it("does not mutate the previous draft", () => {
    const base = emptyHostConfigInputV2();
    const snapshot = JSON.parse(JSON.stringify(base.clientCapabilities));
    withEmaExtension(base);
    withoutEmaExtension(base);
    expect(base.clientCapabilities).toEqual(snapshot);
  });

  it("preserves a pre-existing EMA value object on toggle-on", () => {
    const base = emptyHostConfigInputV2({
      clientCapabilities: {
        extensions: { [XAA_MCP_EXTENSION]: { configured: true } },
      },
    });
    const on = withEmaExtension(base);
    expect(extensionsOf(on.clientCapabilities)?.[XAA_MCP_EXTENSION]).toEqual({
      configured: true,
    });
  });

  it("collapses a now-empty extensions container to absent, never dropping clientCapabilities", () => {
    const base = emptyHostConfigInputV2({
      clientCapabilities: { extensions: { [XAA_MCP_EXTENSION]: {} } },
    });
    const off = withoutEmaExtension(base);
    expect(off.clientCapabilities).toEqual({});
    // The canonicalizer throws on undefined clientCapabilities — {} is the floor.
    expect(off.clientCapabilities).not.toBeUndefined();
  });

  it("guards non-object extensions values instead of throwing", () => {
    const base = emptyHostConfigInputV2({
      clientCapabilities: { extensions: "junk" },
    });
    expect(hasEmaExtension(base.clientCapabilities)).toBe(false);

    const on = withEmaExtension(base);
    expect(hasEmaExtension(on.clientCapabilities)).toBe(true);

    const off = withoutEmaExtension(base);
    expect(hasEmaExtension(off.clientCapabilities)).toBe(false);
  });

  it("restores mistral's inert extensions marker on collapse", () => {
    const base = emptyHostConfigInputV2({
      hostStyle: "mistral",
      clientCapabilities: { extensions: { [XAA_MCP_EXTENSION]: {} } },
    });
    const off = withoutEmaExtension(base);
    // Same special case as the Apps tab's withoutMcpUiExtension: mistral's
    // "off" state is represented by an empty extensions map, not absence.
    expect(off.clientCapabilities).toEqual({ extensions: {} });
  });
});
