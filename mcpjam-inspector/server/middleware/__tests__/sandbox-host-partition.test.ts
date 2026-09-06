/**
 * The sandbox hostname's whole job is holding untrusted widget content. It
 * answers the sandbox proxy and /health; everything else it serves is a path
 * that origin should never have had — the app shell, the bundle, the API.
 *
 * The partition is host-gated, so the other half of every case matters just as
 * much: on the app's own hostname nothing may change.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const SANDBOX_HOST = "sandbox.mcpjam.test";
const APP_HOST = "app.mcpjam.test";

const PROXY_PATH = "/api/web/apps/mcp-apps/sandbox-proxy";

/**
 * A stand-in for the routes mounted around the partition in server/index.ts:
 * the proxy, /health, an unrelated /api/web route, an asset, and the SPA
 * fallback. Every one of them answers 200 without the partition.
 */
async function buildApp() {
  vi.resetModules();
  const { applySandboxHostPartition, SANDBOX_HOST_OPEN_PATHS } =
    await import("../sandbox-host-partition.js");

  // Adding a third path to an origin that exists to hold untrusted content is
  // a decision, not a detail. Make it fail here first.
  expect([...SANDBOX_HOST_OPEN_PATHS]).toEqual([PROXY_PATH, "/health"]);

  const app = new Hono();
  applySandboxHostPartition(app);
  app.get(PROXY_PATH, (c) => c.html("<!doctype html><title>proxy</title>"));
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/api/web/projects", (c) => c.json({ projects: [] }));
  app.get("/assets/index.js", (c) => c.text("console.log(1)"));
  app.get("*", (c) => c.html("<!doctype html><title>app</title>"));
  return app;
}

async function status(app: Hono, path: string, host: string): Promise<number> {
  const res = await app.request(`http://${host}${path}`, {
    headers: { Host: host },
  });
  return res.status;
}

describe("sandbox host", () => {
  let app: Hono;

  beforeAll(async () => {
    vi.stubEnv("SANDBOX_HOSTS", SANDBOX_HOST);
    app = await buildApp();
  });
  afterAll(() => vi.unstubAllEnvs());

  it("serves the sandbox proxy", async () => {
    expect(await status(app, PROXY_PATH, SANDBOX_HOST)).toBe(200);
  });

  it("serves the proxy with the renderer's cache-buster attached", async () => {
    expect(
      await status(app, `${PROXY_PATH}?v=1750000000000`, SANDBOX_HOST),
    ).toBe(200);
  });

  it("serves /health, so the canary and the platform probe still work", async () => {
    expect(await status(app, "/health", SANDBOX_HOST)).toBe(200);
  });

  it("404s the app shell, the bundle, and the rest of the API", async () => {
    for (const path of ["/", "/assets/index.js", "/api/web/projects"]) {
      expect(await status(app, path, SANDBOX_HOST), path).toBe(404);
    }
  });

  it("404s a sub-path of the proxy — the allowlist is exact", async () => {
    expect(await status(app, `${PROXY_PATH}/content`, SANDBOX_HOST)).toBe(404);
  });

  it("matches the host regardless of port or case", async () => {
    expect(await status(app, "/", `${SANDBOX_HOST}:6274`)).toBe(404);
    expect(await status(app, "/", SANDBOX_HOST.toUpperCase())).toBe(404);
  });
});

describe("per-server view host", () => {
  // `<label>.<sandbox host>` is minted per MCP server so one server's views
  // get their own origin — cookie and storage isolation between apps.
  const LABEL_HOST = `0123456789abcdef.${SANDBOX_HOST}`;
  let app: Hono;

  beforeAll(async () => {
    vi.stubEnv("SANDBOX_HOSTS", SANDBOX_HOST);
    app = await buildApp();
  });
  afterAll(() => vi.unstubAllEnvs());

  it("serves the sandbox proxy", async () => {
    expect(await status(app, PROXY_PATH, LABEL_HOST)).toBe(200);
  });

  it("does not serve /health", async () => {
    // Nothing derived from a server id has business describing this service's
    // infrastructure, and no operator probes such a name.
    expect(await status(app, "/health", LABEL_HOST)).toBe(404);
  });

  it("404s everything else, as the parent host does", async () => {
    expect(await status(app, "/", LABEL_HOST)).toBe(404);
    expect(await status(app, "/api/web/projects", LABEL_HOST)).toBe(404);
    expect(await status(app, "/assets/index.js", LABEL_HOST)).toBe(404);
  });

  it("only matches a label this service would actually mint", async () => {
    // Not hex, wrong length, nested, or under a host that is not ours — none
    // are names the deriver produces, so they are not partitioned at all and
    // fall through to the ordinary app.
    for (const host of [
      `zzzzzzzzzzzzzzzz.${SANDBOX_HOST}`,
      `0123456789abcde.${SANDBOX_HOST}`,
      `0123456789abcdef0.${SANDBOX_HOST}`,
      `a.0123456789abcdef.${SANDBOX_HOST}`,
      "0123456789abcdef.evil.example",
    ]) {
      expect(await status(app, "/api/web/projects", host), host).toBe(200);
    }
  });
});

describe("app host", () => {
  let app: Hono;

  beforeAll(async () => {
    vi.stubEnv("SANDBOX_HOSTS", SANDBOX_HOST);
    app = await buildApp();
  });
  afterAll(() => vi.unstubAllEnvs());

  it("is untouched — every path still answers as it did", async () => {
    for (const path of [
      "/",
      "/assets/index.js",
      "/api/web/projects",
      "/health",
      PROXY_PATH,
    ]) {
      expect(await status(app, path, APP_HOST), path).toBe(200);
    }
  });
});

describe("SANDBOX_HOSTS empty (the rollback)", () => {
  afterAll(() => vi.unstubAllEnvs());

  it("partitions nothing, on the sandbox hostname included", async () => {
    vi.stubEnv("SANDBOX_HOSTS", "");
    const app = await buildApp();

    for (const path of ["/", "/assets/index.js", "/api/web/projects"]) {
      expect(await status(app, path, SANDBOX_HOST), path).toBe(200);
    }
  });
});

/**
 * An entry that is not a bare hostname can never equal the `Host` header the
 * partition reads, so keeping it would leave that name serving the whole app
 * while the deploy still reported itself isolated.
 */
describe("SANDBOX_HOSTS entries that are not hostnames", () => {
  afterAll(() => vi.unstubAllEnvs());

  it.each([
    ["a scheme", `https://${SANDBOX_HOST}`],
    ["a port", `${SANDBOX_HOST}:443`],
    ["a path", `${SANDBOX_HOST}/proxy`],
    ["an empty entry", " , "],
  ])("is dropped when it carries %s", async (_label, value) => {
    vi.stubEnv("SANDBOX_HOSTS", value);
    const app = await buildApp();

    expect(await status(app, "/", SANDBOX_HOST)).toBe(200);
  });

  it("keeps the valid entries alongside a malformed one", async () => {
    vi.stubEnv("SANDBOX_HOSTS", `https://elsewhere.test,${SANDBOX_HOST}`);
    const app = await buildApp();

    expect(await status(app, "/", SANDBOX_HOST)).toBe(404);
    expect(await status(app, PROXY_PATH, SANDBOX_HOST)).toBe(200);
    expect(await status(app, "/", APP_HOST)).toBe(200);
  });
});

/**
 * The half of the invariant that cannot live in a browser.
 *
 * A page served at sandbox.mcpjam.com with its sandbox origin set to
 * sandbox.mcpjam.com looks exactly like an app.mcpjam.com deploy pointing its
 * sandbox at itself — same equality, opposite verdicts. Only the process knows
 * which hostname it was supposed to answer as, so the check runs at boot and
 * publishes its answer on /health.
 */
async function bootWith(env: {
  sandboxHosts: string;
  hostedOrigin: string;
}): Promise<{ logged: string[]; health: string }> {
  vi.stubEnv("SANDBOX_HOSTS", env.sandboxHosts);
  vi.stubEnv("MCPJAM_HOSTED_ORIGIN", env.hostedOrigin);
  vi.resetModules();

  const logged: string[] = [];
  const { logger } = await import("../../utils/logger.js");
  vi.spyOn(logger, "error").mockImplementation((message: string) => {
    logged.push(message);
  });

  const { assertSandboxIsolation } =
    await import("../sandbox-host-partition.js");
  const { buildHealthMeta } = await import("../../utils/health-payload.js");

  assertSandboxIsolation();
  return { logged, health: buildHealthMeta().sandboxIsolation };
}

describe("boot invariant", () => {
  afterAll(() => vi.unstubAllEnvs());

  it("reports same-origin when the app's own host is listed as a sandbox host", async () => {
    const { logged, health } = await bootWith({
      sandboxHosts: "app.mcpjam.test",
      hostedOrigin: "https://app.mcpjam.test",
    });

    expect(health).toBe("same-origin");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("app.mcpjam.test");
  });

  it("reports unset when SANDBOX_HOSTS is empty", async () => {
    const { logged, health } = await bootWith({
      sandboxHosts: "",
      hostedOrigin: "https://app.mcpjam.test",
    });

    expect(health).toBe("unset");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("SANDBOX_HOSTS");
  });

  it("reports unset when every SANDBOX_HOSTS entry is malformed", async () => {
    const { logged, health } = await bootWith({
      sandboxHosts: "https://sandbox.mcpjam.test",
      hostedOrigin: "https://app.mcpjam.test",
    });

    expect(health).toBe("unset");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("SANDBOX_HOSTS");
  });

  it("reports unset when the hosted origin cannot be parsed to compare against", async () => {
    const { logged, health } = await bootWith({
      sandboxHosts: "sandbox.mcpjam.test",
      hostedOrigin: "app.mcpjam.test",
    });

    expect(health).toBe("unset");
    expect(logged).toHaveLength(1);
  });

  it("stays silent on a deploy whose sandbox host is its own hostname", async () => {
    const { logged, health } = await bootWith({
      sandboxHosts: "sandbox.mcpjam.test",
      hostedOrigin: "https://app.mcpjam.test",
    });

    expect(health).toBe("ok");
    expect(logged).toEqual([]);
  });
});
