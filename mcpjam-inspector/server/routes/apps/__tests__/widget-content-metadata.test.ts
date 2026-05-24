import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import mcpAppsRoutes from "../mcp-apps";
import { requestLogContextMiddleware } from "../../../middleware/request-log-context";

/**
 * Tests for SEP-1865 per-field metadata precedence in /widget-content.
 *
 * The host resolves `csp`, `permissions`, and `prefersBorder` independently
 * from three sources:
 *   1. content-item `_meta.ui` (from `resources/read`)
 *   2. listing `_meta.ui` (from `resources/list`)
 *   3. legacy `openai/widget*` keys on either source
 *
 * The response echoes both:
 *   - `metadataSource`  — summary ("content" | "listing" | "legacy" | "mixed" | "none")
 *   - `metadataSources` — per-field breakdown
 *
 * "mixed" should appear when two fields come from different sources (the
 * P3 review concern).
 */

const HTML = '<!doctype html><html><body>hi</body></html>';
const MCP_APPS_MIMETYPE = "text/html;profile=mcp-app";
const RESOURCE_URI = "ui://test/view.html";

function makeMockManager(opts: {
  contentMeta?: Record<string, unknown>;
  listingMeta?: Record<string, unknown>;
}) {
  return {
    readResource: vi.fn().mockResolvedValue({
      contents: [
        {
          uri: RESOURCE_URI,
          mimeType: MCP_APPS_MIMETYPE,
          text: HTML,
          ...(opts.contentMeta ? { _meta: opts.contentMeta } : {}),
        },
      ],
    }),
    listResources: vi.fn().mockResolvedValue({
      resources: [
        {
          uri: RESOURCE_URI,
          ...(opts.listingMeta ? { _meta: opts.listingMeta } : {}),
        },
      ],
    }),
  };
}

function buildApp(manager: ReturnType<typeof makeMockManager>) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c as any).mcpClientManager = manager;
    await next();
  });
  app.use("*", requestLogContextMiddleware);
  app.route("/api/apps/mcp-apps", mcpAppsRoutes);
  return app;
}

async function postWidgetContent(app: Hono) {
  return app.request("/api/apps/mcp-apps/widget-content", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      serverId: "s1",
      resourceUri: RESOURCE_URI,
      toolId: "t1",
      toolName: "test-tool",
      toolInput: {},
      toolOutput: null,
      cspMode: "widget-declared",
    }),
  });
}

const FULL_UI_META = {
  csp: { connectDomains: ["https://api.example.com"] },
  permissions: { camera: {} },
  prefersBorder: true,
};

describe("/widget-content — SEP-1865 metadata precedence", () => {
  it("reports metadataSource='content' when the content item supplies everything", async () => {
    const manager = makeMockManager({
      contentMeta: { ui: FULL_UI_META },
      listingMeta: undefined,
    });
    const res = await postWidgetContent(buildApp(manager));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metadataSource).toBe("content");
    expect(body.metadataSources).toEqual({
      csp: "content",
      permissions: "content",
      prefersBorder: "content",
    });
  });

  it("falls back to listing _meta.ui when content has no _meta", async () => {
    const manager = makeMockManager({
      contentMeta: undefined,
      listingMeta: { ui: FULL_UI_META },
    });
    const res = await postWidgetContent(buildApp(manager));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metadataSource).toBe("listing");
    expect(body.metadataSources).toEqual({
      csp: "listing",
      permissions: "listing",
      prefersBorder: "listing",
    });
  });

  it("reports metadataSource='mixed' and per-field sources when content and listing each supply different fields", async () => {
    // Content has only prefersBorder; listing has only csp. permissions is
    // absent everywhere. Per-field resolution should pick prefersBorder from
    // content and csp from listing — the summary should be "mixed".
    const manager = makeMockManager({
      contentMeta: { ui: { prefersBorder: true } },
      listingMeta: {
        ui: { csp: { connectDomains: ["https://api.example.com"] } },
      },
    });
    const res = await postWidgetContent(buildApp(manager));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metadataSource).toBe("mixed");
    expect(body.metadataSources).toEqual({
      csp: "listing",
      permissions: "none",
      prefersBorder: "content",
    });
    expect(body.prefersBorder).toBe(true);
    expect(body.csp).toEqual({ connectDomains: ["https://api.example.com"] });
  });

  it("falls back to legacy openai/widget* keys when neither source has _meta.ui", async () => {
    const manager = makeMockManager({
      contentMeta: {
        "openai/widgetCSP": {
          connect_domains: ["https://legacy.example.com"],
        },
        "openai/widgetPrefersBorder": false,
      },
      listingMeta: undefined,
    });
    const res = await postWidgetContent(buildApp(manager));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metadataSource).toBe("legacy");
    expect(body.metadataSources.csp).toBe("legacy");
    expect(body.metadataSources.prefersBorder).toBe("legacy");
    expect(body.csp).toEqual({
      connectDomains: ["https://legacy.example.com"],
    });
    expect(body.prefersBorder).toBe(false);
  });

  it("reports metadataSource='none' when no source has any UI metadata", async () => {
    const manager = makeMockManager({
      contentMeta: undefined,
      listingMeta: undefined,
    });
    const res = await postWidgetContent(buildApp(manager));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metadataSource).toBe("none");
    expect(body.metadataSources).toEqual({
      csp: "none",
      permissions: "none",
      prefersBorder: "none",
    });
  });
});
