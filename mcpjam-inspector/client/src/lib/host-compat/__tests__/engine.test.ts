import { describe, expect, it } from "vitest";
import { evaluateAllHosts } from "../engine";
import { buildHostCompatProfiles } from "../profiles";
import { summarizeReports } from "@/components/compat/HostCompatStrip";
import type {
  CompatVerdict,
  HostCompatReport,
} from "../types";
import type { ListToolsResultWithMetadata } from "@/lib/apis/mcp-tools-api";

// The verdict logic itself (deriveServerRequirements / evaluateHostCompat /
// evaluateMarketHosts / scanWidgetUsage) now lives in the SDK and is tested
// there (`sdk/tests/host-compat-*`). These tests cover only the CLIENT adapter:
// joining presentation (logos + `rendersWidgets`) onto the SDK's logo-free
// reports, plus the `summarizeReports` UI rollup.

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

// Minimal report fixture for the verdict-rollup tests (only `verdict` is read).
const report = (
  over: Pick<HostCompatReport, "hostId" | "verdict"> & Partial<HostCompatReport>,
): HostCompatReport => ({
  hostLabel: over.hostId.toUpperCase(),
  logoSrc: "",
  provenance: "assumed",
  lanes: {
    apps: { verdict: over.verdict, provenance: "assumed" },
    server: { verdict: "works" as CompatVerdict, provenance: "assumed" },
  },
  findings: [],
  ...over,
});

describe("buildHostCompatProfiles (client logo join)", () => {
  it("attaches a per-host logoSrc by id", () => {
    const byId = Object.fromEntries(
      buildHostCompatProfiles().map((p) => [p.id, p]),
    );
    expect(byId.claude?.logoSrc).toBe("/claude_logo.png");
    expect(byId.chatgpt?.logoSrc).toBe("/openai_logo.png");
    expect(byId.codex?.logoSrc).toBe("/codex-logo.svg");
  });

  it("attaches themed logos where the host declares them", () => {
    const goose = buildHostCompatProfiles().find((p) => p.id === "goose");
    expect(goose?.logoSrcByTheme).toEqual({
      light: "/goose_logo_light.png",
      dark: "/goose_logo_dark.png",
    });
    const cline = buildHostCompatProfiles().find((p) => p.id === "cline");
    expect(cline?.logoSrcByTheme).toEqual({
      light: "/cline_logo_light.svg",
      dark: "/cline_logo_dark.svg",
    });
  });

  it("carries the SDK facts through (rendersMcpApps, capabilities)", () => {
    const byId = Object.fromEntries(
      buildHostCompatProfiles().map((p) => [p.id, p]),
    );
    // A rendering host keeps its capability matrix; a CLI host renders no MCP
    // Apps and carries no matrix.
    expect(byId.claude?.rendersMcpApps).toBe(true);
    expect(byId.claude?.capabilities).toBeDefined();
    expect(byId.codex?.rendersMcpApps).toBe(false);
    expect(byId.codex?.capabilities).toBeUndefined();
  });
});

describe("evaluateAllHosts (client presentation join)", () => {
  it("joins logoSrc + rendersWidgets onto every SDK report by host id", () => {
    const { reports } = evaluateAllHosts(toolsWith({ w: mcpAppsMeta() }), {});
    const claude = reports.find((r) => r.hostId === "claude");
    const codex = reports.find((r) => r.hostId === "codex");

    // Logo joined from the client map.
    expect(claude?.logoSrc).toBe("/claude_logo.png");
    expect(codex?.logoSrc).toBe("/codex-logo.svg");

    // A rendering host reports rendersWidgets true; a CLI host false.
    expect(claude?.rendersWidgets).toBe(true);
    expect(codex?.rendersWidgets).toBe(false);
  });

  it("themed logos ride along on the joined reports", () => {
    const { reports } = evaluateAllHosts();
    const goose = reports.find((r) => r.hostId === "goose");
    expect(goose?.logoSrcByTheme).toEqual({
      light: "/goose_logo_light.png",
      dark: "/goose_logo_dark.png",
    });
  });

  it("returns the SDK requirements alongside the joined reports", () => {
    const { requirements, reports } = evaluateAllHosts(
      toolsWith({ w: mcpAppsMeta() }),
      {},
    );
    expect(requirements.hasWidgets).toBe(true);
    expect(reports.length).toBeGreaterThan(0);
  });
});

describe("summarizeReports", () => {
  it("rolls up definite verdicts", () => {
    expect(
      summarizeReports([
        report({ hostId: "a", verdict: "works" }),
        report({ hostId: "b", verdict: "degraded" }),
      ]),
    ).toBe("works in 1 · degraded in 1");
  });

  it("labels an all-unknown result as unknown, not 'checking…'", () => {
    expect(summarizeReports([report({ hostId: "a", verdict: "unknown" })])).toBe(
      "unknown in 1",
    );
  });
});
