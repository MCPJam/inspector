import { describe, expect, it } from "vitest";
import { hostConnectionProfile } from "../src/host-config/internal";
import {
  seedHostTemplate,
  type HostTemplateId,
} from "../src/host-config/templates/seed-host-template";

const profileFor = (id: HostTemplateId) =>
  hostConnectionProfile(
    seedHostTemplate(id) as unknown as Record<string, unknown>,
  );

const extensions = (caps: Record<string, unknown> | undefined) =>
  (caps?.extensions ?? {}) as Record<string, unknown>;

describe("hostConnectionProfile", () => {
  it("derives Claude's identity + the MCP Apps UI capability", () => {
    const p = profileFor("claude");
    expect(p.clientInfo?.name).toBe("claude-ai");
    expect(extensions(p.clientCapabilities)["io.modelcontextprotocol/ui"]).toBeDefined();
    // Claude's model filters app-only tools (default visibility policy).
    expect(p.respectToolVisibility).not.toBe(false);
  });

  it("pins Goose's advertised protocol version", () => {
    expect(profileFor("goose").supportedProtocolVersions).toContain(
      "2025-03-26",
    );
  });

  it("Cursor opts out of tool-visibility filtering", () => {
    expect(profileFor("cursor").respectToolVisibility).toBe(false);
  });

  it("ChatGPT advertises its experimental openai/visibility capability", () => {
    const experimental = (profileFor("chatgpt").clientCapabilities
      ?.experimental ?? {}) as Record<string, { enabled?: boolean }>;
    expect(experimental["openai/visibility"]?.enabled).toBe(true);
  });

  it("returns respectToolVisibility undefined for a config with no host fields", () => {
    expect(hostConnectionProfile({}).respectToolVisibility).toBeUndefined();
  });

  it("reads the protocol-version pin from mcpProfile (sibling of initialize)", () => {
    const p = hostConnectionProfile({
      mcpProfile: {
        mcpProtocolVersion: "2026-07-28",
        initialize: { clientInfo: { name: "x" } },
      },
    });
    expect(p.mcpProtocolVersion).toBe("2026-07-28");
    // A value mistakenly placed under initialize must NOT be read.
    expect(
      hostConnectionProfile({
        mcpProfile: { initialize: { mcpProtocolVersion: "2026-07-28" } },
      }).mcpProtocolVersion,
    ).toBeUndefined();
  });
});
