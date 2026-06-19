import { describe, expect, it } from "vitest";
import {
  deriveServerRequirements,
  evaluateAllHosts,
  evaluateHostCompat,
} from "../engine";
import { summarizeReports } from "@/components/compat/HostCompatStrip";
import type { HostCompatProfile, ServerRequirements } from "../types";
import type { ResolvedMcpAppsCapabilities } from "@/lib/client-styles/types";
import type { ListToolsResultWithMetadata } from "@/lib/apis/mcp-tools-api";

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

const mcpAppsMeta = (extra: Record<string, unknown> = {}) => ({
  ui: { resourceUri: "ui://widget", ...extra },
});
const openaiMeta = { "openai/outputTemplate": "ui://widget" };

const FULL_CAPS: ResolvedMcpAppsCapabilities = {
  availableDisplayModes: ["inline", "fullscreen", "pip"],
  toolInputPartial: true,
  toolCancelled: true,
  hostContextChanged: true,
  resourceTeardown: true,
  toolInfo: true,
  openLinks: true,
  serverTools: true,
  serverResources: true,
  logging: true,
  updateModelContext: true,
  message: true,
  sandboxPermissions: true,
  cspFrameDomains: true,
  cspBaseUriDomains: true,
  resourcePrefersBorder: true,
  downloadFile: true,
  requestTeardown: true,
  widgetDisplayModeRequests: "accept",
};

const profile = (over: Partial<HostCompatProfile> = {}): HostCompatProfile => ({
  id: "x",
  label: "TestHost",
  logoSrc: "",
  provenance: "assumed",
  rendersMcpApps: true,
  rendersOpenAiApps: false,
  capabilities: FULL_CAPS,
  ...over,
});

const reqs = (over: Partial<ServerRequirements> = {}): ServerRequirements => ({
  widgets: { mcpAppsOnly: [], openaiAppsOnly: [], dual: [] },
  appOnlyWidgets: [],
  hasWidgets: false,
  unknownDimensions: [],
  ...over,
});

describe("deriveServerRequirements", () => {
  it("reports unknown widget usage when tools aren't loaded", () => {
    const r = deriveServerRequirements(undefined);
    expect(r.hasWidgets).toBe(false);
    expect(r.unknownDimensions.length).toBe(1);
  });

  it("buckets widgets by bridge and flags app-only tools", () => {
    const r = deriveServerRequirements(
      toolsWith({
        mcpTool: mcpAppsMeta(),
        openaiTool: openaiMeta,
        dualTool: { ...mcpAppsMeta(), ...openaiMeta },
        plainTool: {},
        appOnlyTool: mcpAppsMeta({ visibility: ["app"] }),
      }),
    );
    expect(r.widgets.mcpAppsOnly).toEqual(["mcpTool", "appOnlyTool"]);
    expect(r.widgets.openaiAppsOnly).toEqual(["openaiTool"]);
    expect(r.widgets.dual).toEqual(["dualTool"]);
    expect(r.appOnlyWidgets).toEqual(["appOnlyTool"]);
    expect(r.hasWidgets).toBe(true);
  });

  it("treats a model+app tool as not app-only", () => {
    const r = deriveServerRequirements(
      toolsWith({ t: mcpAppsMeta({ visibility: ["model", "app"] }) }),
    );
    expect(r.appOnlyWidgets).toEqual([]);
  });

  it("marks widget capabilities unknown when widgets aren't scanned", () => {
    const r = deriveServerRequirements(toolsWith({ w: mcpAppsMeta() }), undefined);
    expect(
      r.unknownDimensions.some((d) => /widget capabilities/.test(d)),
    ).toBe(true);
  });

  it("treats a clean scan ({}) as conclusive — no unknown dimension", () => {
    const r = deriveServerRequirements(toolsWith({ w: mcpAppsMeta() }), {});
    expect(
      r.unknownDimensions.some((d) => /widget capabilities/.test(d)),
    ).toBe(false);
  });

  it("does not mark widget capabilities unknown for a server with no widgets", () => {
    const r = deriveServerRequirements(toolsWith({ plain: {} }), undefined);
    expect(
      r.unknownDimensions.some((d) => /widget capabilities/.test(d)),
    ).toBe(false);
  });
});

describe("evaluateHostCompat", () => {
  it("a plain (no-widget) server works everywhere with no findings", () => {
    const report = evaluateHostCompat(reqs(), profile());
    expect(report.verdict).toBe("works");
    expect(report.findings).toEqual([]);
  });

  it("degrades a widget to text on a host that renders no widgets", () => {
    const report = evaluateHostCompat(
      reqs({ widgets: { mcpAppsOnly: ["w"], openaiAppsOnly: [], dual: [] }, hasWidgets: true }),
      profile({ rendersMcpApps: false, rendersOpenAiApps: false, capabilities: undefined }),
    );
    expect(report.verdict).toBe("degraded");
    expect(report.findings[0].title).toMatch(/fall back to text/);
  });

  it("blocks an app-only widget that can't render (no text fallback)", () => {
    const report = evaluateHostCompat(
      reqs({
        widgets: { mcpAppsOnly: ["w"], openaiAppsOnly: [], dual: [] },
        appOnlyWidgets: ["w"],
        hasWidgets: true,
      }),
      profile({ rendersMcpApps: false, rendersOpenAiApps: false, capabilities: undefined }),
    );
    expect(report.verdict).toBe("blocked");
    expect(report.findings[0].title).toMatch(/app-only/);
  });

  it("degrades an OpenAI-only widget on an MCP-Apps-only host, advising the MCP Apps bridge", () => {
    const report = evaluateHostCompat(
      reqs({ widgets: { mcpAppsOnly: [], openaiAppsOnly: ["w"], dual: [] }, hasWidgets: true }),
      profile({ rendersMcpApps: true, rendersOpenAiApps: false }),
    );
    expect(report.verdict).toBe("degraded");
    // The host renders MCP Apps, so the fix is to add that bridge.
    expect(report.findings[0].remediation).toMatch(/MCP Apps template/);
  });

  it("fires a server-specific capability finding when a scanned widget uses an unsupported API", () => {
    const report = evaluateHostCompat(
      reqs({
        widgets: { mcpAppsOnly: ["w"], openaiAppsOnly: [], dual: [] },
        hasWidgets: true,
        widgetUsage: { message: ["w"] },
      }),
      profile({ capabilities: { ...FULL_CAPS, message: false } }),
    );
    expect(report.verdict).toBe("degraded");
    const finding = report.findings.find((f) => /ui\/message/.test(f.detail));
    expect(finding?.detail).toMatch(/`w`/);
  });

  it("reads Unknown (not Works) when a widget server hasn't been scanned", () => {
    // Mirrors what deriveServerRequirements produces for an unscanned widget
    // server: an unknown dimension and no capability findings.
    const report = evaluateHostCompat(
      reqs({
        widgets: { mcpAppsOnly: ["w"], openaiAppsOnly: [], dual: [] },
        hasWidgets: true,
        unknownDimensions: ["widget capabilities (widget HTML not analyzed)"],
      }),
      profile({ capabilities: { ...FULL_CAPS, message: false } }),
    );
    expect(report.verdict).toBe("unknown");
    expect(report.findings).toEqual([]);
  });

  it("does not fire a capability finding the widget doesn't actually use", () => {
    const report = evaluateHostCompat(
      reqs({
        widgets: { mcpAppsOnly: ["w"], openaiAppsOnly: [], dual: [] },
        hasWidgets: true,
        widgetUsage: { serverTools: ["w"] }, // uses serverTools, not message
      }),
      profile({ capabilities: { ...FULL_CAPS, message: false } }),
    );
    expect(report.findings).toEqual([]);
    expect(report.verdict).toBe("works");
  });

  it("does not report capability gaps for a server with no widgets", () => {
    const report = evaluateHostCompat(
      reqs({ widgetUsage: { message: ["w"] } }),
      profile({ capabilities: { ...FULL_CAPS, message: false } }),
    );
    expect(report.findings).toEqual([]);
  });
});

describe("evaluateAllHosts (real registry)", () => {
  it("a dual-bridge widget works in Claude but degrades in Codex (CLI)", () => {
    const { reports } = evaluateAllHosts(
      toolsWith({ w: { ...mcpAppsMeta(), ...openaiMeta } }),
      {}, // conclusive clean scan — isolate the render verdict
    );
    const claude = reports.find((r) => r.hostId === "claude");
    const codex = reports.find((r) => r.hostId === "codex");
    expect(claude?.verdict).toBe("works");
    expect(codex?.verdict).toBe("degraded");
  });

  it("treats n8n as a headless tools-only client", () => {
    const { reports } = evaluateAllHosts(toolsWith({ w: mcpAppsMeta() }), {});
    const n8n = reports.find((r) => r.hostId === "n8n");
    expect(n8n?.verdict).toBe("degraded");
    expect(n8n?.findings[0].title).toMatch(/fall back to text/);
  });

  it("treats Perplexity as a headless tools-only client", () => {
    const { reports } = evaluateAllHosts(toolsWith({ w: mcpAppsMeta() }), {});
    const perplexity = reports.find((r) => r.hostId === "perplexity");
    expect(perplexity?.verdict).toBe("degraded");
    expect(perplexity?.findings[0].title).toMatch(/fall back to text/);
  });

  it("renders MCP Apps widgets in ChatGPT (does NOT fall back to text)", () => {
    const { reports } = evaluateAllHosts(toolsWith({ w: mcpAppsMeta() }), {});
    const chatgpt = reports.find((r) => r.hostId === "chatgpt");
    // ChatGPT renders both bridges — an MCP Apps widget must render here.
    expect(
      chatgpt?.findings.some((f) => /fall back to text/.test(f.title)),
    ).toBe(false);
    // Its only gaps are info-level (serverResources / logging), so: Works.
    expect(chatgpt?.verdict).toBe("works");
  });

  it("renders MCP Apps widgets in Goose but reports scanned bridge gaps", () => {
    const clean = evaluateAllHosts(toolsWith({ w: mcpAppsMeta() }), {});
    const gooseClean = clean.reports.find((r) => r.hostId === "goose");
    expect(
      gooseClean?.findings.some((f) => /fall back to text/.test(f.title)),
    ).toBe(false);
    expect(gooseClean?.verdict).toBe("works");

    const scanned = evaluateAllHosts(toolsWith({ w: mcpAppsMeta() }), {
      message: ["w"],
    });
    const gooseScanned = scanned.reports.find((r) => r.hostId === "goose");
    expect(gooseScanned?.verdict).toBe("degraded");
    expect(
      gooseScanned?.findings.some((f) => /ui\/message/.test(f.detail)),
    ).toBe(true);
  });

  it("surfaces Cursor's follow-up gap only for a widget that actually uses it", () => {
    const { reports } = evaluateAllHosts(toolsWith({ w: mcpAppsMeta() }), {
      message: ["w"],
    });
    const cursor = reports.find((r) => r.hostId === "cursor");
    // Cursor renders MCP Apps, so no text-fallback finding…
    expect(cursor?.findings.some((f) => /fall back to text/.test(f.title))).toBe(
      false,
    );
    // …and its matrix has `message` off, so the scanned widget's use of it
    // surfaces a server-specific finding naming the tool.
    const finding = cursor?.findings.find((f) => /ui\/message/.test(f.detail));
    expect(finding?.detail).toMatch(/`w`/);
    // Claude supports `message` → no such finding even though the widget uses it.
    const claude = reports.find((r) => r.hostId === "claude");
    expect(claude?.findings.some((f) => /ui\/message/.test(f.detail))).toBe(false);
  });
});

describe("summarizeReports", () => {
  it("rolls up definite verdicts", () => {
    expect(
      summarizeReports([
        { hostId: "a", hostLabel: "A", logoSrc: "", verdict: "works", provenance: "assumed", findings: [] },
        { hostId: "b", hostLabel: "B", logoSrc: "", verdict: "degraded", provenance: "assumed", findings: [] },
      ]),
    ).toBe("works in 1 · degraded in 1");
  });

  it("labels an all-unknown result as unknown, not 'checking…'", () => {
    expect(
      summarizeReports([
        { hostId: "a", hostLabel: "A", logoSrc: "", verdict: "unknown", provenance: "assumed", findings: [] },
      ]),
    ).toBe("unknown in 1");
  });
});
