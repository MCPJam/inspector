/**
 * The hosted-browser synthetic route, wired the way `app.ts` and `index.ts`
 * wire it (session auth on `*` first), with the reserve, browserd and delete
 * seams mocked at the edge of the process. Everything between them is real:
 * the orchestration, the browserd WebMCP provider and the session runtime,
 * so a pass here means the tool list really came through the provider's
 * parser and the runtime's tool map.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { BrowserCommand } from "../../../services/browserd/protocol";

const seams = vi.hoisted(() => ({
  ensureComputerReady: vi.fn(),
  isComputersDataPlaneConfigured: vi.fn(),
  ensureLiveBrowserSession: vi.fn(),
  convexDeleteDesktopComputer: vi.fn(),
  isHostedDesktopUnavailable: vi.fn(),
}));

vi.mock("../../../utils/computers/control-plane-client.js", async () => ({
  ...(await vi.importActual<
    typeof import("../../../utils/computers/control-plane-client.js")
  >("../../../utils/computers/control-plane-client.js")),
  ensureComputerReady: seams.ensureComputerReady,
  isComputersDataPlaneConfigured: seams.isComputersDataPlaneConfigured,
}));
vi.mock("../../../services/browserd/live-session-deps.js", () => ({
  ensureLiveBrowserSession: seams.ensureLiveBrowserSession,
}));
vi.mock("../../../utils/computers/convex-environment-client.js", async () => ({
  ...(await vi.importActual<
    typeof import("../../../utils/computers/convex-environment-client.js")
  >("../../../utils/computers/convex-environment-client.js")),
  convexDeleteDesktopComputer: seams.convexDeleteDesktopComputer,
}));
vi.mock("../../../utils/computers/runtime-config.js", async () => ({
  ...(await vi.importActual<
    typeof import("../../../utils/computers/runtime-config.js")
  >("../../../utils/computers/runtime-config.js")),
  isHostedDesktopUnavailable: seams.isHostedDesktopUnavailable,
}));

const { sessionAuthMiddleware } =
  await import("../../../middleware/session-auth.js");
const { default: internalHostedBrowserSynthetic } =
  await import("../hosted-browser-synthetic.js");
const { registerSyntheticWebMcpPageRoutes, SYNTHETIC_TOOL_NAME } =
  await import("../../synthetic-webmcp-page.js");

const SERVICE_TOKEN = "test-inspector-service-token";
const PUBLIC_URL = "https://inspector.example.com";
const BEARER = "synthetic-run-bearer";
const PROJECT = "proj_synthetic";

function createApp(): Hono {
  const app = new Hono();
  app.use("*", sessionAuthMiddleware);
  app.route("/api/internal/hosted-browser", internalHostedBrowserSynthetic);
  registerSyntheticWebMcpPageRoutes(app);
  return app;
}

function run(
  body: unknown = { projectId: PROJECT, bearer: BEARER },
  headers: Record<string, string> = {
    "x-inspector-service-token": SERVICE_TOKEN,
  },
) {
  return createApp().request("/api/internal/hosted-browser/synthetic", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** A browserd that serves the page's tools on `observe`, or none on the empty page. */
function fakeBrowserd() {
  const commands: BrowserCommand[] = [];
  let url = "";
  const client = {
    sendCommand: vi.fn(async (command: BrowserCommand) => {
      commands.push(command);
      const action = command.action;
      if (action.kind === "navigate") url = action.url;
      const tools =
        action.kind === "observe" && !url.endsWith("-empty")
          ? [
              {
                name: SYNTHETIC_TOOL_NAME,
                frameId: "frame-main",
                origin: PUBLIC_URL,
                isMainFrame: true,
                registrationKind: "imperative",
                description: "Echoes its input.",
              },
            ]
          : [];
      return {
        status: "ok",
        bootId: "boot-1",
        result: { ok: true, output: { tools } },
      };
    }),
  };
  const handle = {
    engine: "hosted",
    target: "computer",
    computerId: "comp-1",
    sessionId: "bs-1",
    bootId: "boot-1",
    streamUrl: "https://stream.example.com",
    streamPassword: "stream-password",
    contextMode: "persistent",
    reused: false,
    client,
  };
  return { handle, commands };
}

function navigatedUrls(commands: BrowserCommand[]): string[] {
  return commands.flatMap((command) =>
    command.action.kind === "navigate" ? [command.action.url] : [],
  );
}

let browserd: ReturnType<typeof fakeBrowserd>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", SERVICE_TOKEN);
  vi.stubEnv("MCPJAM_INSPECTOR_PUBLIC_URL", PUBLIC_URL);
  vi.stubEnv("CONVEX_URL", "https://backend.example.convex.cloud");
  browserd = fakeBrowserd();
  seams.isComputersDataPlaneConfigured.mockReturnValue(true);
  seams.isHostedDesktopUnavailable.mockReturnValue(false);
  seams.ensureComputerReady.mockResolvedValue({
    ok: true,
    value: { computerId: "comp-1", status: "ready" },
  });
  seams.ensureLiveBrowserSession.mockResolvedValue(browserd.handle);
  seams.convexDeleteDesktopComputer.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("a run", () => {
  it("reserves, boots, lists the page's tool and deletes the desktop", async () => {
    const res = await run();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      stage: "complete",
      toolCount: 1,
    });
    expect(seams.ensureComputerReady).toHaveBeenCalledWith(
      expect.objectContaining({
        bearer: BEARER,
        projectId: PROJECT,
        runtimeKind: "desktop-browser",
      }),
    );
    expect(seams.ensureLiveBrowserSession).toHaveBeenCalledWith(
      expect.objectContaining({
        bearer: BEARER,
        projectId: PROJECT,
        contextMode: "persistent",
      }),
    );
    expect(navigatedUrls(browserd.commands)).toEqual([
      `${PUBLIC_URL}/synthetic/webmcp`,
    ]);
    expect(seams.convexDeleteDesktopComputer).toHaveBeenCalledWith(
      BEARER,
      PROJECT,
    );
  });

  it("fails at tools on the empty page, which is how an operator forces a page", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const pending = run({ projectId: PROJECT, bearer: BEARER, page: "empty" });
    // The check re-reads an empty list for a while before giving up on it.
    await vi.advanceTimersByTimeAsync(15_000);
    const res = await pending;

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: false,
      stage: "tools",
      toolCount: 0,
    });
    expect(navigatedUrls(browserd.commands)).toEqual([
      `${PUBLIC_URL}/synthetic/webmcp-empty`,
    ]);
    expect(seams.convexDeleteDesktopComputer).toHaveBeenCalledTimes(1);
  });

  it("reports a refused reserve under reserve and still deletes", async () => {
    seams.ensureComputerReady.mockResolvedValue({
      ok: false,
      status: 403,
      error: "Not authorized for this project",
    });

    const res = await run();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, stage: "reserve", toolCount: 0 });
    expect(body.error).toContain("reserve failed (403)");
    expect(seams.ensureLiveBrowserSession).not.toHaveBeenCalled();
    expect(seams.convexDeleteDesktopComputer).toHaveBeenCalledTimes(1);
  });

  it("refuses a body without a project or bearer", async () => {
    const res = await run({ projectId: PROJECT });

    expect(res.status).toBe(400);
    expect(seams.ensureComputerReady).not.toHaveBeenCalled();
  });
});

describe("authorization", () => {
  it.each([
    ["no service token", {}],
    ["a wrong service token", { "x-inspector-service-token": "nope" }],
    // A browser session is not the backend.
    ["a user bearer", { authorization: `Bearer ${BEARER}` }],
  ])("refuses %s before reserving anything", async (_label, headers) => {
    const res = await run(undefined, headers);

    expect(res.status).toBe(401);
    expect(seams.ensureComputerReady).not.toHaveBeenCalled();
    expect(seams.convexDeleteDesktopComputer).not.toHaveBeenCalled();
  });

  it("refuses everyone when this inspector holds no service token", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");

    const res = await run();

    expect(res.status).toBe(401);
    expect(seams.ensureComputerReady).not.toHaveBeenCalled();
  });
});

describe("unset config", () => {
  it.each([
    [
      "no computers data plane",
      () => seams.isComputersDataPlaneConfigured.mockReturnValue(false),
      /data plane/,
    ],
    [
      "no desktop template or rate",
      () => seams.isHostedDesktopUnavailable.mockReturnValue(true),
      /desktop template/,
    ],
    ["no CONVEX_URL", () => vi.stubEnv("CONVEX_URL", ""), /CONVEX_URL/],
    [
      "no public URL for the page",
      () => vi.stubEnv("MCPJAM_INSPECTOR_PUBLIC_URL", ""),
      /public HTTPS URL/,
    ],
  ])(
    "answers 503 at config with %s, reserving nothing",
    async (_label, unset, error) => {
      unset();

      const res = await run();

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toMatchObject({ ok: false, stage: "config", toolCount: 0 });
      expect(body.error).toMatch(error);
      expect(seams.ensureComputerReady).not.toHaveBeenCalled();
      expect(seams.convexDeleteDesktopComputer).not.toHaveBeenCalled();
    },
  );
});

describe("the test page", () => {
  it("registers one tool, pinned by the policy's script hash, with no credential", async () => {
    const res = await createApp().request("/synthetic/webmcp");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("origin-agent-cluster")).toBe("?1");
    const html = await res.text();
    expect(html).toContain(`name: "${SYNTHETIC_TOOL_NAME}"`);
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
    const hash = createHash("sha256").update(script).digest("base64");
    expect(res.headers.get("content-security-policy")).toContain(
      `script-src 'sha256-${hash}'`,
    );
  });

  it("serves an empty variant with no script at all", async () => {
    const res = await createApp().request("/synthetic/webmcp-empty");

    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("<script");
    expect(res.headers.get("content-security-policy")).not.toContain(
      "script-src",
    );
  });
});
