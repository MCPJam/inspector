import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ingest = vi.hoisted(() => vi.fn());
vi.mock("@axiomhq/js", () => ({
  Axiom: class {
    ingest = ingest;
    flush = async () => undefined;
  },
}));

const id = (seed: string) => seed.padEnd(32, "0");
const FORGED = id("forged");
const scope = (tenant: string) => ({
  orgId: id(`org${tenant}`),
  projectId: id(`project${tenant}`),
  serverId: id(`server${tenant}`),
});
/** What Convex's authorize endpoints return as `internalLogContext`. */
const AUTHORIZED: Record<string, Record<string, unknown>> = {
  a: scope("a"),
  b: scope("b"),
  none: {},
  malformed: {
    orgId: "PRIVATE_SENTINEL",
    projectId: id("project").toUpperCase(),
    serverId: `${id("server")}0`,
  },
};

/** A route that, like `authorizeServer`, logs the scope Convex authorized. */
async function testApp(gate = async (_tenant: string) => {}) {
  const { Hono } = await import("hono");
  const { requestLogContextMiddleware } = await import(
    "../../middleware/request-log-context.js"
  );
  const { getRequestLogger, setRequestLogContext } = await import(
    "../request-logger.js"
  );
  const { mapInternalToRequestContext } = await import(
    "../internal-log-context.js"
  );
  const { logger } = await import("../logger.js");
  const app = new Hono();
  app.use("/api/*", requestLogContextMiddleware);
  app.post("/api/web/tools/execute", async (c) => {
    const tenant = c.req.query("tenant") ?? "";
    const authorized = AUTHORIZED[tenant];
    if (authorized)
      setRequestLogContext(c, mapInternalToRequestContext(authorized));
    await gate(tenant);
    getRequestLogger(c, "routes.web.tools").event("mcp.tool.execution.failed", {
      toolName: "PRIVATE_SENTINEL",
      serverId: FORGED,
      errorCode: "mcp_error",
    });
    logger.warn("[web/tools] task registry write skipped", {
      orgId: FORGED,
      serverId: FORGED,
    });
    return c.json({ ok: true });
  });
  return (tenant: string) =>
    app.request(`/api/web/tools/execute?tenant=${tenant}`, { method: "POST" });
}

const rows = () =>
  ingest.mock.calls.flatMap(([, batch]) => batch as Record<string, unknown>[]);
const ids = (row: Record<string, unknown>) => [
  row.orgId,
  row.projectId,
  row.serverId,
];

describe("verified IDs in ingested log rows", () => {
  beforeEach(() => {
    vi.resetModules();
    ingest.mockClear();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENVIRONMENT", "test");
    vi.stubEnv("AXIOM_TOKEN", "test-token");
    vi.stubEnv("DO_NOT_TRACK", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("puts the authorized IDs on the request's typed rows and nothing else", async () => {
    await (await testApp())("a");
    const [failed, legacy, completed] = rows();
    expect(ingest).toHaveBeenCalledTimes(3);
    for (const [, batch] of ingest.mock.calls) expect(batch).toHaveLength(1);
    expect(failed.event).toBe("mcp.tool.execution.failed");
    expect(completed.event).toBe("http.request.completed");
    for (const row of [failed, completed])
      expect(ids(row)).toEqual(ids(AUTHORIZED.a));
    expect(ids(legacy)).toEqual([undefined, undefined, undefined]);
    expect(JSON.stringify(rows())).not.toMatch(/forged|PRIVATE_SENTINEL/);
    const { INSPECTOR_SENTRY_CATALOG, rebuildSentryEvent } = await import(
      "../../../shared/strict-sentry.js"
    );
    const sentry = rebuildSentryEvent({ extra: failed }, INSPECTOR_SENTRY_CATALOG);
    expect(JSON.stringify(sentry)).not.toContain(AUTHORIZED.a.orgId);
  });

  it("keeps concurrent requests' IDs apart", async () => {
    const release: Record<string, () => void> = {};
    const request = await testApp(
      (tenant) => new Promise((resolve) => (release[tenant] = resolve)),
    );
    const pending = ["a", "b"].map((tenant) => request(tenant));
    // Both requests hold their authorized context before either one logs.
    await vi.waitFor(() => expect(Object.keys(release)).toHaveLength(2));
    release.b();
    await pending[1];
    release.a();
    await pending[0];
    const typed = rows().filter((row) => !String(row.event).startsWith("log."));
    expect(typed.map((row) => [row.event, ...ids(row)])).toEqual([
      ["mcp.tool.execution.failed", ...ids(AUTHORIZED.b)],
      ["http.request.completed", ...ids(AUTHORIZED.b)],
      ["mcp.tool.execution.failed", ...ids(AUTHORIZED.a)],
      ["http.request.completed", ...ids(AUTHORIZED.a)],
    ]);
  });

  it.each([
    ["none", "returned none"],
    ["malformed", "returned malformed ones"],
    ["unauthorized", "never ran"],
  ])(
    "logs no ID when authorization (%s) %s, whatever the payload says",
    async (tenant) => {
      await (await testApp())(tenant);
      expect(rows()).toHaveLength(3);
      for (const row of rows())
        expect(ids(row)).toEqual([undefined, undefined, undefined]);
      expect(JSON.stringify(rows())).not.toMatch(/forged|PRIVATE_SENTINEL/);
    },
  );
});
