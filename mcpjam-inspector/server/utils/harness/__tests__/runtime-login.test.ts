import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cursorRuntimeLogin } from "../runtime-login.js";

beforeEach(() => vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const args = () => ({
  sandboxRowId: "box",
  runId: "turn",
  modelId: "cursor/auto",
  authorization: async () => "Bearer user",
});

describe("Cursor login lifecycle client", () => {
  it("carries only scoped identifiers and clears the same operation", async () => {
    const request = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", request);
    const login = cursorRuntimeLogin(args());
    await login.install();
    await login.clear();
    const bodies = request.mock.calls.map((call) =>
      JSON.parse(String(call[1]?.body)),
    );
    expect(bodies[0]).toEqual(bodies[1]);
    expect(Object.keys(bodies[0]).sort()).toEqual([
      "harnessId",
      "installId",
      "modelId",
      "runId",
      "sandboxRowId",
    ]);
  });
  it("cleans an installation even when its response is lost", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", request);
    const login = cursorRuntimeLogin(args());
    await expect(login.install()).rejects.toThrow("connection lost");
    await login.clear();
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(request.mock.calls[0][1].body).installId).toBe(
      JSON.parse(request.mock.calls[1][1].body).installId,
    );
  });
  it("does not clean a login that was never requested", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    await cursorRuntimeLogin(args()).clear();
    expect(request).not.toHaveBeenCalled();
  });
  it("reports unconfirmed cleanup", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ ok: true }))
        .mockResolvedValueOnce(Response.json({ ok: false }, { status: 409 })),
    );
    const login = cursorRuntimeLogin(args());
    await login.install();
    await expect(login.clear()).rejects.toThrow(
      "cleanup could not be confirmed",
    );
  });
});
