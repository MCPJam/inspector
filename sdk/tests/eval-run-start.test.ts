import { afterEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => vi.resetModules());
vi.unmock("../src/eval-run-start.js");
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEvalRun } from "../src/eval-run-start.js";
import { readStoredAuth, writeStoredAuth } from "../src/platform-auth.js";
import { resolveEvalRunCredential } from "../src/eval-run-credentials.js";

const options = { apiKey: "sk_test", mcpjam: { baseUrl: "http://localhost:3000" }, plannedIterations: 3, providers: ["openai"], usedClientProfile: false };
const receipt = (init: RequestInit) => ({ ok: true, runStartId: JSON.parse(String(init.body)).runStartId, organizationId: "org", projectId: "project" });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("eval run identity", () => {
  it("requires credentials without invoking fetch", async () => {
    vi.stubEnv("MCPJAM_API_KEY", "");
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(startEvalRun({ plannedIterations: 1 })).rejects.toMatchObject({ code: "CREDENTIALS_MISSING" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses one stable id across lost-response and server retries, and a new id for a new run", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher = vi.fn(async (_url, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      if (bodies.length === 1) throw new TypeError("lost response");
      if (bodies.length === 2) return Response.json({}, { status: 503 });
      return Response.json(receipt(init));
    });
    vi.stubGlobal("fetch", fetcher);
    await startEvalRun(options);
    expect(bodies).toHaveLength(3);
    expect(bodies[1]).toEqual(bodies[0]); expect(bodies[2]).toEqual(bodies[0]);
    await startEvalRun(options);
    expect(bodies[3].runStartId).not.toBe(bodies[0].runStartId);
    expect(Object.keys(bodies[0]).sort()).toEqual(["clientVersion", "plannedIterations", "providers", "runStartId", "surface", "usedClientProfile"].sort());
  });
  it.each(["UNAUTHORIZED", "EXPIRED_KEY", "ORPHANED_KEY", "SESSION_REVOKED", "FORBIDDEN", "NOT_FOUND", "CONFLICT"])("preserves the %s cause and does not retry", async (code) => {
    const fetcher = vi.fn(async () => Response.json(["EXPIRED_KEY", "ORPHANED_KEY", "SESSION_REVOKED"].includes(code) ? { code: "UNAUTHORIZED", details: { reason: code } } : { code }, { status: code === "NOT_FOUND" ? 404 : code === "FORBIDDEN" ? 403 : code === "CONFLICT" ? 409 : 401 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(startEvalRun(options)).rejects.toMatchObject({ code });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("reports a long rate limit without waiting beyond the retry budget", async () => {
    const fetcher = vi.fn(async () => Response.json({}, { status: 429, headers: { "retry-after": "60" } }));
    vi.stubGlobal("fetch", fetcher);
    await expect(startEvalRun(options)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("honors opt-out for analytics without skipping accounting or caching success", async () => {
    vi.stubEnv("DO_NOT_TRACK", "1"); vi.stubEnv("MCPJAM_TELEMETRY_DISABLED", "1");
    const fetcher = vi.fn(async (_url, init: RequestInit) => Response.json(receipt(init)));
    vi.stubGlobal("fetch", fetcher);
    await startEvalRun(options);
    fetcher.mockImplementation(async () => { throw new TypeError("offline"); });
    await expect(startEvalRun(options)).rejects.toMatchObject({ code: "PLATFORM_UNAVAILABLE" });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("refreshes getAuth for each retry and bounds a stalled callback", async () => {
    vi.useFakeTimers();
    const getAuth = vi.fn().mockResolvedValueOnce("one").mockResolvedValueOnce("two");
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({}, { status: 500 })).mockImplementation(async (_url, init) => Response.json(receipt(init)));
    vi.stubGlobal("fetch", fetcher);
    const run = startEvalRun({ ...options, apiKey: undefined, mcpjamAuth: { getAuth } });
    await vi.runAllTimersAsync(); await run;
    expect(getAuth).toHaveBeenCalledTimes(2);
    expect(new Headers(fetcher.mock.calls[1][1].headers).get("authorization")).toBe("Bearer two");
    const stalled = startEvalRun({ ...options, apiKey: undefined, mcpjamAuth: { getAuth: () => new Promise(() => {}) } });
    const rejection = expect(stalled).rejects.toMatchObject({ code: "PLATFORM_UNAVAILABLE" });
    await vi.runAllTimersAsync(); await rejection;
  });
  it("uses saved login only after explicit and environment credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eval-auth-"));
    vi.stubEnv("MCPJAM_AUTH_FILE", join(directory, "auth.json"));
    vi.stubEnv("MCPJAM_API_KEY", "sk_env");
    try {
      await writeStoredAuth({ version: 1, issuer: "https://login.example", clientId: "client", tokenEndpoint: "https://login.example/token", accessToken: "saved", apiUrl: "https://staging.example/api/v1" }, join(directory, "auth.json"));
      expect(await (await resolveEvalRunCredential({ apiKey: "sk_explicit" })).auth.getAuth()).toBe("sk_explicit");
      expect(await (await resolveEvalRunCredential({})).auth.getAuth()).toBe("sk_env");
      await expect(resolveEvalRunCredential({ apiKey: "mcpjam_retired" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      vi.stubEnv("MCPJAM_API_KEY", undefined);
      const saved = await resolveEvalRunCredential({});
      expect(saved.baseUrl).toBe("https://staging.example");
      expect(await saved.auth.getAuth()).toBe("saved");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it.each(["http://example.com", "http://192.168.1.10", "ftp://localhost"])("refuses callback credentials at %s before reading a bearer", async (baseUrl) => {
    const getAuth = vi.fn(async () => "private-login");
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(startEvalRun({ plannedIterations: 1, mcpjam: { baseUrl }, mcpjamAuth: { getAuth } })).rejects.toThrow("https://");
    expect(getAuth).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["https://example.com", "http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"])("allows callback credentials at %s", async (baseUrl) => {
    const fetcher = vi.fn(async (_url, init: RequestInit) => Response.json(receipt(init)));
    vi.stubGlobal("fetch", fetcher);
    await startEvalRun({ plannedIterations: 1, mcpjam: { baseUrl }, mcpjamAuth: { getAuth: async () => "login" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("coalesces delayed callbacks across timeouts and never sends a late request", async () => {
    vi.useFakeTimers();
    let finish!: (value: string) => void;
    const getAuth = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const run = startEvalRun({ ...options, apiKey: undefined, mcpjamAuth: { getAuth } });
    const rejection = expect(run).rejects.toMatchObject({ code: "PLATFORM_UNAVAILABLE" });
    await vi.advanceTimersByTimeAsync(10_000); await rejection;
    expect(getAuth).toHaveBeenCalledTimes(1);
    finish("late-login"); await vi.runAllTimersAsync();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("persists one delayed token rotation after timeout and shares it with the next run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eval-refresh-"));
    const authFilePath = join(directory, "auth.json");
    vi.stubEnv("MCPJAM_AUTH_FILE", authFilePath);
    vi.stubEnv("MCPJAM_API_KEY", "");
    vi.useFakeTimers();
    let finish!: (value: Response) => void;
    const refresh = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const starts = vi.fn(async (_url, init: RequestInit) => Response.json(receipt(init)));
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => url.endsWith("/token") ? refresh() : starts(url, init));
    try {
      await writeStoredAuth({ version: 1, issuer: "https://login.example", clientId: "client", tokenEndpoint: "https://login.example/token", accessToken: "expired", refreshToken: "rotation-one", expiresAt: Date.now() - 1, apiUrl: "https://example.com/api/v1" }, authFilePath);
      const first = startEvalRun({ plannedIterations: 1 });
      const rejection = expect(first).rejects.toMatchObject({ code: "PLATFORM_UNAVAILABLE" });
      await vi.advanceTimersByTimeAsync(10_000); await rejection;
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(readStoredAuth(authFilePath)?.refreshToken).toBe("rotation-one");
      const second = startEvalRun({ plannedIterations: 1 });
      await vi.advanceTimersByTimeAsync(0);
      expect(refresh).toHaveBeenCalledTimes(1);
      finish(Response.json({ access_token: "fresh", refresh_token: "rotation-two", expires_in: 3600 }));
      await second;
      expect(starts).toHaveBeenCalledTimes(1);
      expect(new Headers(starts.mock.calls[0][1].headers).get("authorization")).toBe("Bearer fresh");
      expect(readStoredAuth(authFilePath)?.refreshToken).toBe("rotation-two");
      await startEvalRun({ plannedIterations: 1 });
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
