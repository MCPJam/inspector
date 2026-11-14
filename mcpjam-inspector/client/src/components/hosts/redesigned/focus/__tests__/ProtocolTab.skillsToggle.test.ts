import { describe, expect, it } from "vitest";
import { emptyHostConfigInputV2 } from "@/lib/client-config-v2";
import {
  MCP_SKILLS_EXTENSION_ID,
  XAA_MCP_EXTENSION,
} from "@mcpjam/sdk/browser";
import {
  hasClientExtension,
  withClientExtension,
  withoutClientExtension,
} from "../ProtocolTab";

const UI_EXTENSION = "io.modelcontextprotocol/ui";

function extensionsOf(caps: Record<string, unknown> | undefined) {
  return (caps as { extensions?: Record<string, unknown> } | undefined)
    ?.extensions;
}

describe("ProtocolTab Skills over MCP switch helpers", () => {
  it("round-trips on/off while preserving sibling extensions", () => {
    const base = emptyHostConfigInputV2();
    expect(
      hasClientExtension(base.clientCapabilities, MCP_SKILLS_EXTENSION_ID),
    ).toBe(false);

    const on = withClientExtension(base, MCP_SKILLS_EXTENSION_ID);
    expect(
      hasClientExtension(on.clientCapabilities, MCP_SKILLS_EXTENSION_ID),
    ).toBe(true);
    // The value the connect seams and the SDK's mutual-declaration check read.
    expect(
      extensionsOf(on.clientCapabilities)?.[MCP_SKILLS_EXTENSION_ID],
    ).toEqual({});
    expect(extensionsOf(on.clientCapabilities)?.[UI_EXTENSION]).toBeDefined();

    const off = withoutClientExtension(on, MCP_SKILLS_EXTENSION_ID);
    expect(
      hasClientExtension(off.clientCapabilities, MCP_SKILLS_EXTENSION_ID),
    ).toBe(false);
    expect(off.clientCapabilities).toEqual(base.clientCapabilities);
  });

  it("leaves the enterprise auth extension alone", () => {
    const base = emptyHostConfigInputV2({
      clientCapabilities: {
        extensions: {
          [XAA_MCP_EXTENSION]: {},
          [MCP_SKILLS_EXTENSION_ID]: {},
        },
      },
    });
    const off = withoutClientExtension(base, MCP_SKILLS_EXTENSION_ID);
    expect(off.clientCapabilities).toEqual({
      extensions: { [XAA_MCP_EXTENSION]: {} },
    });
  });

  it("does not mutate the previous draft", () => {
    const base = emptyHostConfigInputV2();
    const snapshot = JSON.parse(JSON.stringify(base.clientCapabilities));
    withClientExtension(base, MCP_SKILLS_EXTENSION_ID);
    withoutClientExtension(base, MCP_SKILLS_EXTENSION_ID);
    expect(base.clientCapabilities).toEqual(snapshot);
  });
});
