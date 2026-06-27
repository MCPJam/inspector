import { describe, expect, it } from "vitest";
import {
  deriveServerRequirements,
  evaluateAllHosts,
  evaluateHostCompat,
  detectHostCompatBridgeFromMeta,
  HostCompatBridge,
  type HostCompatProfile,
  type HostCompatToolsInput,
  type ServerRequirements,
} from "../src/host-compat/index";
import type { McpAppsCapabilities } from "../src/host-config/types";

const toolsWith = (
  toolsMetadata: Record<string, Record<string, unknown>>,
): HostCompatToolsInput => ({
  tools: Object.keys(toolsMetadata).map((name) => ({ name })),
  toolsMetadata,
});

const mcpAppsMeta = (extra: Record<string, unknown> = {}) => ({
  ui: { resourceUri: "ui://widget", ...extra },
});
const openaiMeta = { "openai/outputTemplate": "ui://widget" };

const FULL_CAPS: McpAppsCapabilities = {
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

describe("detectHostCompatBridgeFromMeta", () => {
  it("classifies by _meta bridge declarations", () => {
    expect(detectHostCompatBridgeFromMeta(mcpAppsMeta())).toBe(
      HostCompatBridge.MCP_APPS,
    );
    expect(detectHostCompatBridgeFromMeta(openaiMeta)).toBe(
      HostCompatBridge.OPENAI_SDK,
    );
    expect(
      detectHostCompatBridgeFromMeta({ ...mcpAppsMeta(), ...openaiMeta }),
    ).toBe(HostCompatBridge.OPENAI_SDK_AND_MCP_APPS);
    expect(detectHostCompatBridgeFromMeta({})).toBeNull();
  });

  it("requires a real template string (not just truthy metadata)", () => {
    // Malformed metadata must not classify as a widget.
    expect(
      detectHostCompatBridgeFromMeta({ "openai/outputTemplate": {} }),
    ).toBeNull();
    expect(
      detectHostCompatBridgeFromMeta({ "openai/outputTemplate": "" }),
    ).toBeNull();
  });
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

  it("uses the canonical app-only predicate: only exactly ['app'] is app-only", () => {
    // Empty or multi-element visibility defaults to model-visible at runtime
    // (SDK `isAppOnlyTool`), so it must NOT read as app-only here — otherwise an
    // unrenderable widget gets a `blocked` verdict despite having text fallback.
    const r = deriveServerRequirements(
      toolsWith({
        appOnly: mcpAppsMeta({ visibility: ["app"] }),
        emptyVis: mcpAppsMeta({ visibility: [] }),
        multiVis: mcpAppsMeta({ visibility: ["app", "extra"] }),
      }),
    );
    expect(r.appOnlyWidgets).toEqual(["appOnly"]);
  });

  it("distinguishes an unscanned widget server (unknown) from a clean scan ({})", () => {
    expect(
      deriveServerRequirements(
        toolsWith({ w: mcpAppsMeta() }),
        undefined,
      ).unknownDimensions.some((d) => /widget capabilities/.test(d)),
    ).toBe(true);
    expect(
      deriveServerRequirements(
        toolsWith({ w: mcpAppsMeta() }),
        {},
      ).unknownDimensions.some((d) => /widget capabilities/.test(d)),
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
    expect(
      report.findings.find((f) => /ui\/message/.test(f.detail))?.detail,
    ).toMatch(/`w`/);
  });

  it("reads Unknown (not Works) when a widget server hasn't been scanned", () => {
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

  it("surfaces a protocol-version difference as an info finding + unknown verdict", () => {
    const report = evaluateHostCompat(
      reqs({ connectionFacts: { protocolVersion: "2099-01-01" } }),
      profile({ supportedProtocolVersions: ["2025-11-25"] }),
    );
    const f = report.findings.find((x) => x.lane === "server");
    expect(f?.severity).toBe("info");
    expect(report.lanes.server.verdict).toBe("unknown");
    expect(report.verdict).toBe("unknown");
  });

  it("stays works on a protocol-version match", () => {
    const report = evaluateHostCompat(
      reqs({ connectionFacts: { protocolVersion: "2025-11-25" } }),
      profile({ supportedProtocolVersions: ["2025-06-18", "2025-11-25"] }),
    );
    expect(report.verdict).toBe("works");
  });

  it("emits no logo fields (facts only)", () => {
    const report = evaluateHostCompat(reqs(), profile());
    expect("logoSrc" in report).toBe(false);
  });
});

describe("semantic finding contract (code / tools / capability)", () => {
  const headless = () =>
    profile({
      rendersMcpApps: false,
      rendersOpenAiApps: false,
      capabilities: undefined,
    });

  it("tags an app-only render failure", () => {
    const f = evaluateHostCompat(
      reqs({
        widgets: { mcpAppsOnly: ["w"], openaiAppsOnly: [], dual: [] },
        appOnlyWidgets: ["w"],
        hasWidgets: true,
      }),
      headless(),
    ).findings[0];
    expect(f.code).toBe("app_only_unrenderable");
    if (f.code === "app_only_unrenderable") expect(f.tools).toEqual(["w"]);
  });

  it("tags a text-fallback render failure", () => {
    const f = evaluateHostCompat(
      reqs({
        widgets: { mcpAppsOnly: ["w"], openaiAppsOnly: [], dual: [] },
        hasWidgets: true,
      }),
      headless(),
    ).findings[0];
    expect(f.code).toBe("widget_text_fallback");
    if (f.code === "widget_text_fallback") expect(f.tools).toEqual(["w"]);
  });

  it("tags a capability gap with the capability key", () => {
    const f = evaluateHostCompat(
      reqs({
        widgets: { mcpAppsOnly: ["w"], openaiAppsOnly: [], dual: [] },
        hasWidgets: true,
        widgetUsage: { message: ["w"] },
      }),
      profile({ capabilities: { ...FULL_CAPS, message: false } }),
    ).findings.find((x) => x.code === "capability_unsupported");
    expect(f).toBeDefined();
    if (f?.code === "capability_unsupported") {
      expect(f.capability).toBe("message");
      expect(f.tools).toEqual(["w"]);
    }
  });

  it("does not alias the shared widgetUsage array (defensive copy)", () => {
    const usage = { message: ["w"] };
    const f = evaluateHostCompat(
      reqs({
        widgets: { mcpAppsOnly: ["w"], openaiAppsOnly: [], dual: [] },
        hasWidgets: true,
        widgetUsage: usage,
      }),
      profile({ capabilities: { ...FULL_CAPS, message: false } }),
    ).findings.find((x) => x.code === "capability_unsupported");
    // A surface sorting/mutating finding.tools must not touch widgetUsage.
    if (f?.code === "capability_unsupported") {
      expect(f.tools).not.toBe(usage.message);
      f.tools.push("mutated");
    }
    expect(usage.message).toEqual(["w"]);
  });

  it("tags a protocol-version mismatch", () => {
    const f = evaluateHostCompat(
      reqs({ connectionFacts: { protocolVersion: "2099-01-01" } }),
      profile({ supportedProtocolVersions: ["2025-11-25"] }),
    ).findings.find((x) => x.lane === "server");
    expect(f?.code).toBe("protocol_version_mismatch");
  });
});

describe("evaluateAllHosts", () => {
  it("evaluates the supplied profiles and returns the requirements", () => {
    const { requirements, reports } = evaluateAllHosts(
      toolsWith({ w: mcpAppsMeta() }),
      [
        profile({ id: "renders", label: "Renders", rendersMcpApps: true }),
        profile({
          id: "headless",
          label: "Headless",
          rendersMcpApps: false,
          rendersOpenAiApps: false,
          capabilities: undefined,
        }),
      ],
      { widgetUsage: {} }, // conclusive clean scan
    );
    expect(requirements.hasWidgets).toBe(true);
    expect(reports.find((r) => r.hostId === "renders")?.verdict).toBe("works");
    expect(reports.find((r) => r.hostId === "headless")?.verdict).toBe(
      "degraded",
    );
  });
});
