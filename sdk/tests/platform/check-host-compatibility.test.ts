import { describe, expect, it, vi } from "vitest";
import {
  checkHostCompatibilityOperation,
  PlatformApiClient,
} from "../../src/platform/index.js";

const PROJECT = {
  id: "p1",
  name: "Proj",
  description: null,
  icon: null,
  organizationId: "o1",
  visibility: null,
  createdAt: 1,
  updatedAt: 1,
};

const HTTP_SERVER = {
  id: "s1",
  projectId: "p1",
  name: "Echo",
  enabled: true,
  transportType: "http",
  url: "https://echo.example/mcp",
  useOAuth: false,
  hasClientSecret: false,
  createdAt: null,
  updatedAt: null,
};

/** A PlatformApiClient whose fetch serves one widget tool + its resource HTML. */
function makeClient(toolMeta: Record<string, unknown>, resourceHtml: string) {
  const fetchMock = vi.fn(async (target: unknown) => {
    const path = new URL(String(target)).pathname;
    if (path === "/api/v1/projects") return Response.json({ items: [PROJECT] });
    if (/\/servers$/.test(path)) return Response.json({ items: [HTTP_SERVER] });
    // Single page (no nextCursor) — a raw MCP tool carries `_meta` inline.
    if (/\/servers\/[^/]+\/tools$/.test(path)) {
      return Response.json({ items: [{ name: "chart", _meta: toolMeta }] });
    }
    if (/\/servers\/[^/]+\/resources\/read$/.test(path)) {
      return Response.json({ contents: [{ text: resourceHtml }] });
    }
    return Response.json({ code: "NOT_FOUND", message: path }, { status: 404 });
  });
  return new PlatformApiClient({
    baseUrl: "https://api.example.com/api/v1",
    getAuth: () => "sk_test",
    fetch: fetchMock as unknown as typeof fetch,
  });
}

const verdictById = (
  result: Awaited<ReturnType<typeof checkHostCompatibilityOperation.execute>>,
) => Object.fromEntries(result.hosts.map((h) => [h.hostId, h.verdict]));

describe("checkHostCompatibilityOperation", () => {
  it("returns per-host verdicts for a widget server", async () => {
    const client = makeClient(
      { ui: { resourceUri: "ui://chart" } },
      "<div>just markup</div>",
    );
    const result = await checkHostCompatibilityOperation.execute(
      { server: "Echo" },
      { client },
    );
    expect(result.server.name).toBe("Echo");
    expect(result.widgets.total).toBe(1);
    const byId = verdictById(result);
    expect(byId.claude).toBe("works"); // renders MCP Apps + clean scan
    expect(byId.codex).toBe("degraded"); // headless → widget falls back to text
  });

  it("scans the widget HTML and surfaces capability findings", async () => {
    const client = makeClient(
      { ui: { resourceUri: "ui://chart" } },
      "window.openai.sendFollowUpMessage()", // → needs `message`
    );
    const result = await checkHostCompatibilityOperation.execute(
      { server: "Echo" },
      { client },
    );
    const cursor = result.hosts.find((h) => h.hostId === "cursor");
    expect(cursor?.verdict).toBe("degraded"); // Cursor lacks `message`
    expect(
      cursor?.findings.some((f) => f.code === "capability_unsupported"),
    ).toBe(true);
    // Claude supports `message` → still works.
    expect(verdictById(result).claude).toBe("works");
  });
});
