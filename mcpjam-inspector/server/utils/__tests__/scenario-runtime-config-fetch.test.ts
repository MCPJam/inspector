import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchScenarioRuntimeConfig,
  SCENARIO_HARNESS_BOX_VERSION,
} from "../scenario-runtime-config.js";

/**
 * The runtime-config read declares, by VERSION, that this caller can run a
 * non-member participant's harness on the conversation's box. A caller that
 * cannot must not declare it: the backend would then grant a harness it has
 * nowhere to run.
 */
describe("fetchScenarioRuntimeConfig — harness-box declaration", () => {
  const originalFetch = global.fetch;
  const originalUrl = process.env.CONVEX_HTTP_URL;
  let bodies: Array<Record<string, unknown>>;

  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    bodies = [];
    global.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, config: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    global.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.CONVEX_HTTP_URL;
    else process.env.CONVEX_HTTP_URL = originalUrl;
  });

  it("sends the version only when the caller can provision the box", async () => {
    await fetchScenarioRuntimeConfig({
      scenarioId: "cbx_1",
      bearer: "t",
      harnessBox: true,
    });
    await fetchScenarioRuntimeConfig({ scenarioId: "cbx_1", bearer: "t" });
    await fetchScenarioRuntimeConfig({
      scenarioId: "cbx_1",
      bearer: "t",
      harnessBox: false,
    });

    expect(bodies[0]).toEqual({
      scenarioId: "cbx_1",
      harnessBoxVersion: SCENARIO_HARNESS_BOX_VERSION,
    });
    // Byte-identical to every request that predates it.
    expect(bodies[1]).toEqual({ scenarioId: "cbx_1" });
    expect(bodies[2]).toEqual({ scenarioId: "cbx_1" });
  });

  it("authenticates the execution peer while retaining the tester bearer", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "fixture-service-credential");
    await fetchScenarioRuntimeConfig({ scenarioId: "study", bearer: "tester-bearer" });
    expect(global.fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      redirect: "error",
      headers: expect.objectContaining({
        authorization: "Bearer tester-bearer",
        "x-inspector-service-token": "fixture-service-credential",
      }),
    }));
  });

  it("omits peer authentication when the server has no service credential", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
    await fetchScenarioRuntimeConfig({ scenarioId: "study", bearer: "tester-bearer" });
    const init = vi.mocked(global.fetch).mock.calls[0]?.[1];
    expect(new Headers(init?.headers).has("x-inspector-service-token")).toBe(false);
  });

  it("pins the backend's literal", () => {
    expect(SCENARIO_HARNESS_BOX_VERSION).toBe(1);
  });
});
