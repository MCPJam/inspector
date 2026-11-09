import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
vi.mock("../../utils/request-logger.js", () => ({
  getSystemLogger: () => ({ event: vi.fn() }),
}));
import relayRoutes, { RELAY_MOUNT_PREFIXES, relayBodyLimit } from "../relay";

const token = "phc_dTOPniyUNU2kD8Jx8yHMXSqiZHM8I91uWopTMX6EBE9";

function relayApp() {
  const app = new Hono();
  for (const prefix of RELAY_MOUNT_PREFIXES) {
    app.use(`${prefix}/*`, relayBodyLimit());
    app.route(prefix, relayRoutes);
  }
  return app;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the relay under DO_NOT_TRACK", () => {
  it.each(["1", "true"])(
    "forwards nothing on either mount when DO_NOT_TRACK=%s",
    async (value) => {
      vi.stubEnv("DO_NOT_TRACK", value);
      const upstream = vi.fn(async () => new Response("ok"));
      vi.stubGlobal("fetch", upstream);
      const app = relayApp();

      for (const prefix of RELAY_MOUNT_PREFIXES) {
        for (const request of [
          new Request(`http://localhost${prefix}/static/array.js`),
          new Request(`http://localhost${prefix}/array/${token}/config`),
          new Request(`http://localhost${prefix}/e/`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ api_key: token, batch: [] }),
          }),
          new Request(`http://localhost${prefix}/launch-engagement`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          }),
        ]) {
          const response = await app.request(request);
          expect(response.status, request.url).toBe(403);
          await expect(response.json()).resolves.toEqual({
            error: "telemetry_disabled",
          });
        }
      }
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it("still forwards when DO_NOT_TRACK holds any other value", async () => {
    vi.stubEnv("DO_NOT_TRACK", "0");
    const upstream = vi.fn(async () => new Response("console.log(1)"));
    vi.stubGlobal("fetch", upstream);

    const response = await relayApp().request(
      "http://localhost/tlm/static/array.js",
    );

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
