import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

/**
 * Hosted-mode `/web/apps/mcp-apps/widget-content` coverage.
 *
 * Two properties this route regressed on, both SEP-1865 conformance
 * defects that rendered a declared App as a blank box on the User Testing
 * surface:
 *
 *   1. It withheld the resource's declared `csp` whenever the request asked
 *      for `cspMode: "permissive"` — which scenario / minimal surfaces
 *      always do. With no baseline, the client's `resolveSandboxCsp` fell
 *      back to the empty secure default under a `mode: "declared"` host
 *      profile and emitted the strictest possible CSP.
 *   2. It read `_meta.ui` only from the `resources/read` content item. The
 *      spec requires hosts to check the `resources/list` entry too,
 *      "preferring the content item and falling back to the listing entry."
 *
 * The local route (routes/apps/mcp-apps) is covered by
 * routes/apps/__tests__/widget-content-metadata.test.ts; both now share
 * utils/ui-resource-meta.ts.
 */

const HTML = "<!doctype html><html><body>hi</body></html>";
const MCP_APPS_MIMETYPE = "text/html;profile=mcp-app";
const RESOURCE_URI = "ui://test/view.html";

const managerState = vi.hoisted(() => ({
  readResource: vi.fn(),
  listResources: vi.fn(),
}));

// `withEphemeralConnection` normally authorizes the caller and spins up a
// real ephemeral MCP connection. Stub it down to "parse the body, hand the
// route a manager, JSON-encode whatever it returns" — this suite is about
// the route's metadata resolution, not the hosted auth path.
vi.mock("../auth.js", async () => {
  const { z } = await import("zod");
  class WebRouteError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    WebRouteError,
    ErrorCode: new Proxy({}, { get: (_t, key) => String(key) }),
    projectServerSchema: z
      .object({
        projectId: z.string().min(1),
        serverId: z.string().min(1),
      })
      .passthrough(),
    assertBearerToken: () => "token",
    handleRoute: async (c: any, fn: () => Promise<unknown>) => {
      try {
        return c.json(await fn(), 200);
      } catch (error: any) {
        return c.json({ error: error?.message }, error?.status ?? 500);
      }
    },
    withEphemeralConnection: async (c: any, schema: any, fn: any) => {
      const body = schema.parse(await c.req.json());
      try {
        return c.json(await fn(managerState, body), 200);
      } catch (error: any) {
        return c.json({ error: error?.message }, error?.status ?? 500);
      }
    },
  };
});

import appsRoutes from "../apps.js";

function makeApp() {
  const app = new Hono();
  app.route("/api/web/apps", appsRoutes);
  return app;
}

function mockResource(opts: {
  contentMeta?: Record<string, unknown>;
  listingMeta?: Record<string, unknown>;
  listResourcesRejects?: boolean;
}) {
  managerState.readResource.mockResolvedValue({
    contents: [
      {
        uri: RESOURCE_URI,
        mimeType: MCP_APPS_MIMETYPE,
        text: HTML,
        ...(opts.contentMeta ? { _meta: opts.contentMeta } : {}),
      },
    ],
  });
  if (opts.listResourcesRejects) {
    managerState.listResources.mockRejectedValue(
      new Error("Method not found: resources/list")
    );
  } else {
    managerState.listResources.mockResolvedValue({
      resources: [
        {
          uri: RESOURCE_URI,
          ...(opts.listingMeta ? { _meta: opts.listingMeta } : {}),
        },
      ],
    });
  }
}

async function postWidgetContent(
  app: Hono,
  cspMode: "permissive" | "widget-declared" = "widget-declared"
) {
  return app.request("/api/web/apps/mcp-apps/widget-content", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: "Bearer test",
    },
    body: JSON.stringify({
      projectId: "p1",
      serverId: "s1",
      resourceUri: RESOURCE_URI,
      toolId: "t1",
      toolName: "test-tool",
      toolInput: {},
      toolOutput: null,
      cspMode,
    }),
  });
}

const ESM_CSP = {
  resourceDomains: ["https://esm.sh"],
  connectDomains: ["https://esm.sh"],
};

describe("hosted /widget-content — declared CSP", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports the declared csp when the request asks for cspMode='permissive'", async () => {
    // The exact failing configuration from the User Testing surface: an
    // App declaring esm.sh, fetched by a scenario surface (which always
    // sends `permissive`). The declaration must survive to the client so
    // its `mode: "declared"` host profile has a real baseline to resolve.
    mockResource({ contentMeta: { ui: { csp: ESM_CSP } } });
    const res = await postWidgetContent(makeApp(), "permissive");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.csp).toEqual(ESM_CSP);
    // `permissive` is unchanged — it alone decides whether the sandbox
    // proxy injects a meta-CSP.
    expect(body.permissive).toBe(true);
    expect(body.cspMode).toBe("permissive");
  });

  it("reports the declared csp under cspMode='widget-declared' too", async () => {
    mockResource({ contentMeta: { ui: { csp: ESM_CSP } } });
    const res = await postWidgetContent(makeApp(), "widget-declared");
    const body = await res.json();
    expect(body.csp).toEqual(ESM_CSP);
    expect(body.permissive).toBe(false);
  });

  it("leaves csp undefined when the resource declares nothing (spec default)", async () => {
    mockResource({});
    const res = await postWidgetContent(makeApp(), "permissive");
    const body = await res.json();
    expect(body.csp).toBeUndefined();
    expect(body.metadataSource).toBe("none");
  });
});

describe("hosted /widget-content — malformed declarations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("drops non-array domain fields instead of passing them downstream", async () => {
    // `_meta` is server-controlled and unvalidated. Downstream consumers
    // assume `string[]`: the SDK resolver spreads each field (throws on a
    // number) and the sandbox proxy's buildCSP iterates it. A malformed
    // declaration must degrade, not take down the render — and reporting
    // the declaration under `permissive` (this PR) newly exposes scenario
    // surfaces to that path.
    mockResource({
      contentMeta: {
        ui: {
          csp: {
            connectDomains: "https://not-an-array.example.com",
            resourceDomains: ["https://esm.sh", 42, "", "  "],
            frameDomains: null,
          },
        },
      },
    });
    const res = await postWidgetContent(makeApp(), "permissive");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.csp).toEqual({ resourceDomains: ["https://esm.sh"] });
  });

  it("treats an entirely malformed csp as absent so lower sources still win", async () => {
    mockResource({
      contentMeta: { ui: { csp: "totally-not-a-csp" } },
      listingMeta: { ui: { csp: ESM_CSP } },
    });
    const res = await postWidgetContent(makeApp());
    const body = await res.json();
    expect(body.csp).toEqual(ESM_CSP);
    expect(body.metadataSources.csp).toBe("listing");
  });

  it("preserves an explicitly empty domain list as a real declaration", async () => {
    // `{ connectDomains: [] }` means "allow nothing here" — a declaration,
    // not a missing one. Collapsing it to undefined would hand the decision
    // to a lower-precedence source the App didn't intend.
    mockResource({
      contentMeta: { ui: { csp: { connectDomains: [] } } },
      listingMeta: { ui: { csp: ESM_CSP } },
    });
    const res = await postWidgetContent(makeApp());
    const body = await res.json();
    expect(body.csp).toEqual({ connectDomains: [] });
    expect(body.metadataSources.csp).toBe("content");
  });

  it("preserves a bare empty csp object as a deny-by-default declaration", async () => {
    // `_meta.ui.csp: {}` omits every domain field to ask for the secure
    // default. Treating it as absent would let the listing entry supply a
    // BROADER policy than the content item asked for — a precedence
    // inversion in the widening direction, which is the dangerous one.
    mockResource({
      contentMeta: { ui: { csp: {} } },
      listingMeta: { ui: { csp: ESM_CSP } },
    });
    const res = await postWidgetContent(makeApp());
    const body = await res.json();
    expect(body.csp).toEqual({});
    expect(body.metadataSources.csp).toBe("content");
  });

  it("keeps content precedence when its only declared fields are malformed", async () => {
    // Same principle one step further: the object is a declaration, so a
    // field that sanitizes away to nothing still means deny-by-default
    // rather than handing the decision to a broader lower source.
    mockResource({
      contentMeta: { ui: { csp: { connectDomains: 42 } } },
      listingMeta: { ui: { csp: ESM_CSP } },
    });
    const res = await postWidgetContent(makeApp());
    const body = await res.json();
    expect(body.csp).toEqual({});
    expect(body.metadataSources.csp).toBe("content");
  });

  it("ignores a non-boolean prefersBorder", async () => {
    mockResource({ contentMeta: { ui: { prefersBorder: "yes" } } });
    const res = await postWidgetContent(makeApp());
    const body = await res.json();
    expect(body.prefersBorder).toBeUndefined();
    expect(body.metadataSources.prefersBorder).toBe("none");
  });
});

describe("hosted /widget-content — SEP-1865 metadata precedence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to the listing _meta.ui when the content item has none", async () => {
    mockResource({
      listingMeta: {
        ui: { csp: ESM_CSP, permissions: { camera: {} }, prefersBorder: true },
      },
    });
    const res = await postWidgetContent(makeApp());
    const body = await res.json();
    expect(body.csp).toEqual(ESM_CSP);
    expect(body.permissions).toEqual({ camera: {} });
    expect(body.prefersBorder).toBe(true);
    expect(body.metadataSource).toBe("listing");
    expect(body.metadataSources).toEqual({
      csp: "listing",
      permissions: "listing",
      prefersBorder: "listing",
    });
  });

  it("prefers the content item over the listing entry", async () => {
    mockResource({
      contentMeta: { ui: { csp: { connectDomains: ["https://content"] } } },
      listingMeta: { ui: { csp: { connectDomains: ["https://listing"] } } },
    });
    const res = await postWidgetContent(makeApp());
    const body = await res.json();
    expect(body.csp).toEqual({ connectDomains: ["https://content"] });
    expect(body.metadataSources.csp).toBe("content");
  });

  it("resolves per field, reporting 'mixed' when sources differ", async () => {
    mockResource({
      contentMeta: { ui: { prefersBorder: false } },
      listingMeta: { ui: { csp: ESM_CSP } },
    });
    const res = await postWidgetContent(makeApp());
    const body = await res.json();
    expect(body.csp).toEqual(ESM_CSP);
    expect(body.prefersBorder).toBe(false);
    expect(body.metadataSource).toBe("mixed");
    expect(body.metadataSources).toEqual({
      csp: "listing",
      permissions: "none",
      prefersBorder: "content",
    });
  });

  it("falls back to legacy openai/widget* keys on either source", async () => {
    mockResource({
      contentMeta: {
        "openai/widgetCSP": { connect_domains: ["https://legacy.example.com"] },
        "openai/widgetPrefersBorder": false,
      },
    });
    const res = await postWidgetContent(makeApp());
    const body = await res.json();
    expect(body.csp).toEqual({
      connectDomains: ["https://legacy.example.com"],
    });
    expect(body.prefersBorder).toBe(false);
    expect(body.metadataSource).toBe("legacy");
  });

  it("follows resources/list pagination to find a later-page declaration", async () => {
    // `resources/list` is paginated and the listing declaration can sit on
    // any page. Searching only page one would report a declared App as
    // undeclared — the exact blank-render failure this fallback exists to
    // prevent.
    managerState.readResource.mockResolvedValue({
      contents: [
        { uri: RESOURCE_URI, mimeType: MCP_APPS_MIMETYPE, text: HTML },
      ],
    });
    managerState.listResources.mockImplementation(
      async (_serverId: string, params?: { cursor?: string }) => {
        if (!params?.cursor) {
          return {
            resources: [{ uri: "ui://other/a.html" }],
            nextCursor: "page-2",
          };
        }
        return {
          resources: [{ uri: RESOURCE_URI, _meta: { ui: { csp: ESM_CSP } } }],
        };
      }
    );

    const res = await postWidgetContent(makeApp(), "permissive");
    const body = await res.json();
    expect(body.csp).toEqual(ESM_CSP);
    expect(body.metadataSources.csp).toBe("listing");
    expect(managerState.listResources).toHaveBeenCalledTimes(2);
  });

  it("stops paginating as soon as the resource is found", async () => {
    // Latency guard: the walk must not enumerate the whole catalog once it
    // has what it came for.
    managerState.listResources.mockImplementation(async () => ({
      resources: [{ uri: RESOURCE_URI, _meta: { ui: { csp: ESM_CSP } } }],
      nextCursor: "page-2",
    }));
    managerState.readResource.mockResolvedValue({
      contents: [
        { uri: RESOURCE_URI, mimeType: MCP_APPS_MIMETYPE, text: HTML },
      ],
    });

    const res = await postWidgetContent(makeApp());
    const body = await res.json();
    expect(body.csp).toEqual(ESM_CSP);
    expect(managerState.listResources).toHaveBeenCalledTimes(1);
  });

  it("caps the pagination walk instead of enumerating a huge catalog", async () => {
    // A server that paginates forever must not hold the App's HTML hostage.
    managerState.readResource.mockResolvedValue({
      contents: [
        { uri: RESOURCE_URI, mimeType: MCP_APPS_MIMETYPE, text: HTML },
      ],
    });
    managerState.listResources.mockImplementation(async () => ({
      resources: [{ uri: "ui://other/a.html" }],
      nextCursor: "more",
    }));

    const res = await postWidgetContent(makeApp());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.html).toBe(HTML);
    expect(body.metadataSource).toBe("none");
    expect(managerState.listResources).toHaveBeenCalledTimes(5);
  });

  it("still serves the App when the server has no resources/list", async () => {
    // Best-effort lookup: a server that doesn't implement `resources/list`
    // must be no worse off than before the listing fallback existed.
    mockResource({
      contentMeta: { ui: { csp: ESM_CSP } },
      listResourcesRejects: true,
    });
    const res = await postWidgetContent(makeApp());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.html).toBe(HTML);
    expect(body.csp).toEqual(ESM_CSP);
    expect(body.metadataSources.csp).toBe("content");
  });
});
