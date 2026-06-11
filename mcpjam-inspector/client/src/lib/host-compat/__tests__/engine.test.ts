import { describe, expect, it } from "vitest";
import {
  deriveServerRequirements,
  evaluateHostCompat,
} from "../engine";
import {
  CHATGPT_COMPAT_PROFILE,
  CLAUDE_COMPAT_PROFILE,
  CODEX_COMPAT_PROFILE,
  COPILOT_COMPAT_PROFILE,
  CURSOR_COMPAT_PROFILE,
} from "../profiles";
import type { ServerWithName } from "@/state/app-types";
import type { ListToolsResultWithMetadata } from "@/lib/apis/mcp-tools-api";

const baseServer = (overrides: Partial<ServerWithName>): ServerWithName =>
  ({
    name: "test-server",
    config: { url: new URL("https://example.com/mcp") },
    lastConnectionTime: new Date(),
    connectionStatus: "connected",
    retryCount: 0,
    ...overrides,
  }) as ServerWithName;

const stdioServer = baseServer({
  config: { command: "npx", args: ["my-server"] } as never,
});

const connectedInfo = {
  protocolVersion: "2025-06-18",
  serverCapabilities: { tools: {}, prompts: {}, resources: {} },
};

const toolsWith = (
  toolsMetadata: Record<string, Record<string, unknown>>,
): ListToolsResultWithMetadata =>
  ({
    tools: Object.keys(toolsMetadata).map((name) => ({
      name,
      inputSchema: { type: "object" },
    })),
    toolsMetadata,
  }) as ListToolsResultWithMetadata;

describe("deriveServerRequirements", () => {
  it("derives transport and OAuth from the config blob", () => {
    const reqs = deriveServerRequirements(
      baseServer({ useOAuth: true, initializationInfo: connectedInfo }),
    );
    expect(reqs.transport).toBe("http");
    expect(reqs.usesOAuth).toBe(true);
    expect(reqs.capabilities?.prompts).toBe(true);
    expect(reqs.capabilities?.logging).toBe(false);
  });

  it("reports unknown dimensions when never connected", () => {
    const reqs = deriveServerRequirements(stdioServer);
    expect(reqs.transport).toBe("stdio");
    expect(reqs.capabilities).toBeUndefined();
    expect(reqs.widgets).toBeUndefined();
    expect(reqs.unknownDimensions).toHaveLength(2);
  });

  it("buckets widget tools by declared bridge", () => {
    const reqs = deriveServerRequirements(
      baseServer({ initializationInfo: connectedInfo }),
      toolsWith({
        mcp_widget: { ui: { resourceUri: "ui://w/a" } },
        openai_widget: { "openai/outputTemplate": "ui://w/b" },
        dual_widget: {
          ui: { resourceUri: "ui://w/c" },
          "openai/outputTemplate": "ui://w/c",
        },
        plain_tool: {},
      }),
    );
    expect(reqs.widgets).toEqual({
      mcpAppsOnly: ["mcp_widget"],
      openaiAppsOnly: ["openai_widget"],
      dual: ["dual_widget"],
    });
  });
});

describe("evaluateHostCompat", () => {
  it("blocks stdio servers on remote-only hosts and not elsewhere", () => {
    const reqs = deriveServerRequirements(stdioServer);
    expect(evaluateHostCompat(reqs, CHATGPT_COMPAT_PROFILE).verdict).toBe(
      "blocked",
    );
    expect(evaluateHostCompat(reqs, COPILOT_COMPAT_PROFILE).verdict).toBe(
      "blocked",
    );
    // Claude reaches stdio; remaining dimensions are unknown, not failing.
    expect(evaluateHostCompat(reqs, CLAUDE_COMPAT_PROFILE).verdict).toBe(
      "unknown",
    );
  });

  it("degrades OpenAI-only widgets on MCP-Apps-only hosts, with remediation", () => {
    const reqs = deriveServerRequirements(
      baseServer({ initializationInfo: { serverCapabilities: { tools: {} } } }),
      toolsWith({
        openai_widget: { "openai/outputTemplate": "ui://w/b" },
      }),
    );
    const report = evaluateHostCompat(reqs, CLAUDE_COMPAT_PROFILE);
    expect(report.verdict).toBe("degraded");
    expect(report.findings[0].title).toContain("1 widget");
    expect(report.findings[0].remediation).toContain("_meta.ui.resourceUri");
  });

  it("lets dual-bridge widgets render on either host kind", () => {
    const reqs = deriveServerRequirements(
      baseServer({ initializationInfo: { serverCapabilities: { tools: {} } } }),
      toolsWith({
        dual_widget: {
          ui: { resourceUri: "ui://w/c" },
          "openai/outputTemplate": "ui://w/c",
        },
      }),
    );
    expect(evaluateHostCompat(reqs, CLAUDE_COMPAT_PROFILE).verdict).toBe(
      "works",
    );
    expect(evaluateHostCompat(reqs, CHATGPT_COMPAT_PROFILE).verdict).toBe(
      "works",
    );
    // Codex has no widget surface at all — dual still degrades there.
    const codex = evaluateHostCompat(reqs, CODEX_COMPAT_PROFILE);
    expect(codex.verdict).toBe("degraded");
  });

  it("degrades advertised prompts/resources on hosts that don't surface them", () => {
    const reqs = deriveServerRequirements(
      baseServer({ initializationInfo: connectedInfo }),
      toolsWith({}),
    );
    const chatgpt = evaluateHostCompat(reqs, CHATGPT_COMPAT_PROFILE);
    expect(chatgpt.verdict).toBe("degraded");
    expect(chatgpt.findings.map((f) => f.title)).toEqual([
      "Prompts won't appear",
      "Resources won't be browsable",
    ]);
    expect(evaluateHostCompat(reqs, CURSOR_COMPAT_PROFILE).verdict).toBe(
      "works",
    );
  });
});
