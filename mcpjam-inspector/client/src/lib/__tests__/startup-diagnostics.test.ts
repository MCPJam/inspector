import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ hosted: false }));

vi.mock("../config", () => ({
  get HOSTED_MODE() {
    return state.hosted;
  },
}));
vi.mock("../PosthogUtils", () => ({ detectPlatform: () => "mac" }));

import {
  buildStartupDiagnostics,
  diagnosticsText,
  probeLocalServer,
} from "../startup-diagnostics";

const answer = (status: number) =>
  vi.fn<typeof fetch>(async () => Response.json({ status: "ok" }, { status }));

describe("probeLocalServer", () => {
  afterEach(() => {
    state.hosted = false;
  });

  it("reports a local server that answers", async () => {
    const result = await probeLocalServer(answer(200));
    expect(result).toMatchObject({ result: "ok" });
  });

  it("does not count the dev server's app page as the local server answering", async () => {
    const appShell = vi.fn<typeof fetch>(
      async () =>
        new Response("<!doctype html>", {
          headers: { "content-type": "text/html" },
        }),
    );
    expect(await probeLocalServer(appShell)).toEqual({ result: "network" });
  });

  it("keeps only the status when the server answers with an error", async () => {
    const result = await probeLocalServer(answer(502));
    expect(result).toMatchObject({ result: "http_error", status: 502 });
  });

  it("tells a timeout from a refused connection", async () => {
    const timedOut = vi.fn<typeof fetch>(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    const refused = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await probeLocalServer(timedOut)).toEqual({ result: "timeout" });
    expect(await probeLocalServer(refused)).toEqual({ result: "network" });
  });

  it("does not probe on the hosted app, which has no local server", async () => {
    state.hosted = true;
    const fetchImpl = answer(200);
    expect(await probeLocalServer(fetchImpl)).toEqual({
      result: "not_applicable",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("diagnosticsText", () => {
  it("lists only closed values and numbers", () => {
    vi.spyOn(performance, "now").mockReturnValue(47_000);
    const text = diagnosticsText(
      buildStartupDiagnostics({
        stage: "app_load/session_refresh_failed",
        failureKind: "transient",
        localServer: { result: "ok", latencyMs: 34 },
      }),
    );
    expect(text).toBe(
      [
        "MCPJam startup diagnostics",
        `Version: ${__APP_VERSION__}`,
        "Platform: mac",
        "Startup stage: app_load/session_refresh_failed",
        "Session refresh: transient",
        "Local server: reachable, 34 ms",
        "Time since start: 47 s",
      ].join("\n"),
    );
    expect(text).not.toMatch(/https?:|@/);
  });
});
