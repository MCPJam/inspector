import { describe, expect, it } from "vitest";
import {
  APPS_CHECK_SOURCES,
  CONFORMANCE_CHECK_SOURCES,
  OAUTH_CHECK_SOURCES,
  PROTOCOL_CHECK_SOURCES,
  TASKS_CHECK_SOURCES,
  conformanceCheckSourceUrl,
} from "../src/conformance-sources.js";
import { CHECK_ERAS, MCP_CHECK_IDS } from "../src/mcp-conformance/types.js";
import { MCP_APPS_CHECK_IDS } from "../src/apps-conformance/types.js";
import { MCP_TASKS_CHECK_IDS } from "../src/tasks-conformance/types.js";
import { CONFORMANCE_CHECK_METADATA } from "../src/oauth-conformance/types.js";

const SUITES = {
  protocol: PROTOCOL_CHECK_SOURCES,
  apps: APPS_CHECK_SOURCES,
  tasks: TASKS_CHECK_SOURCES,
  oauth: OAUTH_CHECK_SOURCES,
} as const;

const ALLOWED_HOSTS = new Set([
  "modelcontextprotocol.io",
  "github.com",
  "www.rfc-editor.org",
]);

describe("conformance check sources", () => {
  it("covers every check id of every suite, and nothing else", () => {
    expect(Object.keys(PROTOCOL_CHECK_SOURCES).sort()).toEqual(
      [...MCP_CHECK_IDS].sort()
    );
    expect(Object.keys(APPS_CHECK_SOURCES).sort()).toEqual(
      [...MCP_APPS_CHECK_IDS].sort()
    );
    expect(Object.keys(TASKS_CHECK_SOURCES).sort()).toEqual(
      [...MCP_TASKS_CHECK_IDS].sort()
    );
    expect(Object.keys(OAUTH_CHECK_SOURCES).sort()).toEqual(
      Object.keys(CONFORMANCE_CHECK_METADATA).sort()
    );
  });

  it("keeps check ids unique across suites so one table can resolve them", () => {
    const total = Object.values(SUITES).reduce(
      (sum, suite) => sum + Object.keys(suite).length,
      0
    );
    expect(Object.keys(CONFORMANCE_CHECK_SOURCES)).toHaveLength(total);
  });

  it("links only to https pages on the spec's own hosts", () => {
    for (const source of Object.values(CONFORMANCE_CHECK_SOURCES)) {
      if (!source) continue;
      for (const url of [source.legacy, source.modern]) {
        if (url === undefined) continue;
        const parsed = new URL(url);
        expect(parsed.protocol).toBe("https:");
        expect(ALLOWED_HOSTS.has(parsed.host)).toBe(true);
      }
    }
  });

  it("names a section for every era a protocol check runs in", () => {
    for (const id of MCP_CHECK_IDS) {
      const source = PROTOCOL_CHECK_SOURCES[id];
      for (const era of CHECK_ERAS[id]) {
        expect(source[era as keyof typeof source], `${id} (${era})`).toMatch(
          era === "legacy" ? /\/2025-11-25\// : /\/2026-07-28\//
        );
      }
    }
  });
});

describe("conformanceCheckSourceUrl", () => {
  it("picks the section of the negotiated revision", () => {
    expect(conformanceCheckSourceUrl("tools-list", "2025-06-18")).toBe(
      "https://modelcontextprotocol.io/specification/2025-11-25/server/tools#listing-tools"
    );
    expect(conformanceCheckSourceUrl("tools-list", "2026-07-28")).toBe(
      "https://modelcontextprotocol.io/specification/2026-07-28/server/tools#listing-tools"
    );
  });

  it("prefers the current revision when the version is unknown", () => {
    const modern =
      "https://modelcontextprotocol.io/specification/2026-07-28/server/tools#listing-tools";
    expect(conformanceCheckSourceUrl("tools-list")).toBe(modern);
    expect(conformanceCheckSourceUrl("tools-list", null)).toBe(modern);
    expect(conformanceCheckSourceUrl("tools-list", "1999-01-01")).toBe(modern);
  });

  it("links a single-era check to its era whatever the version says", () => {
    expect(conformanceCheckSourceUrl("ping", "2026-07-28")).toBe(
      "https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/ping"
    );
    expect(
      conformanceCheckSourceUrl("modern-server-discover", "2025-11-25")
    ).toBe(
      "https://modelcontextprotocol.io/specification/2026-07-28/server/discover"
    );
  });

  it("resolves the extension suites from their own specs", () => {
    expect(conformanceCheckSourceUrl("ui-tools-present", "2025-11-25")).toMatch(
      /^https:\/\/github\.com\/modelcontextprotocol\/ext-apps\//
    );
    expect(
      conformanceCheckSourceUrl("tasks-mcp-name-routing", "2026-07-28")
    ).toMatch(/^https:\/\/github\.com\/modelcontextprotocol\/ext-tasks\//);
    expect(conformanceCheckSourceUrl("tasks-ttl-shape", "2025-11-25")).toBe(
      "https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#ttl-and-resource-management"
    );
  });

  it("has no link for heuristics, flow steps, or unknown ids", () => {
    expect(conformanceCheckSourceUrl("verify_profile_shape")).toBeUndefined();
    expect(conformanceCheckSourceUrl("authorization_request")).toBeUndefined();
    expect(conformanceCheckSourceUrl("toString")).toBeUndefined();
  });
});
