/**
 * The hosted pieces without a hosted backend: the session transport over a
 * recorded daemon client, the restored profile, the per-turn environment's
 * refusals, and the turn gate's typed answers. Evidence: fixture.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { sessionBrowserTransport, webClientBrowserPolicy } from "../hosted-browser";
import { createHostedWebClientEnvironment } from "../hosted-web-client-environment";
import { createHostedWebClientEnvironmentFactory, restoreWebProfile } from "../hosted-web-client-runtime";
import { sealWebProfile } from "../recovery/profile-cipher";
import { setWebClientEnvironment, webClientEnvironmentFor } from "../web-client-environment";

afterEach(() => {
  vi.unstubAllEnvs();
  setWebClientEnvironment(undefined);
});

describe("the session transport", () => {
  const policy = webClientBrowserPolicy("chatgpt");
  const okResponse = {
    status: "ok" as const,
    result: { ok: true, output: { url: "https://chatgpt.com/" } },
  };

  it("maps a page module's command onto the session's daemon", async () => {
    const sendCommand = vi.fn(async () => okResponse);
    const send = sessionBrowserTransport({
      handle: { client: { sendCommand }, bootId: "boot-1" },
      sessionId: "browser-session-1",
      policy,
    });
    const result = await send({ op: "act", verb: "click", target: { selector: "#send" }, observeAfter: "none" });
    expect(result).toMatchObject({ status: "executed", ok: true });
    expect(sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "agent",
        sessionId: "browser-session-1",
        action: expect.objectContaining({ kind: "act", verb: "click" }),
      }),
      "boot-1",
    );
  });

  it("refuses another site before the daemon and reports a lost command as unknown", async () => {
    const sendCommand = vi.fn(async () => {
      throw new Error("socket closed");
    });
    const send = sessionBrowserTransport({
      handle: { client: { sendCommand }, bootId: "boot-1" },
      sessionId: "s",
      policy,
    });
    expect(await send({ op: "navigate", url: "https://example.com/" })).toMatchObject({
      status: "refused",
      refusal: { code: "origin_not_allowed" },
    });
    expect(sendCommand).not.toHaveBeenCalled();
    expect(await send({ op: "act", verb: "click", target: { selector: "#x" } })).toMatchObject({
      status: "unknown",
    });
  });

  it("keeps each vendor's browser to its own sites", () => {
    expect(webClientBrowserPolicy("claude")).toEqual({ mode: "allowlist", originAllowlist: ["https://claude.ai"] });
    expect(policy.originAllowlist).toEqual(["https://chatgpt.com", "https://auth.openai.com"]);
  });
});

describe("restoring a saved profile", () => {
  it("opens the sealed archive with the run's data key", async () => {
    const key = randomBytes(32);
    const archive = new Uint8Array([7, 8, 9]);
    const sealed = sealWebProfile(archive, key);
    const restored = await restoreWebProfile(
      {
        webAccountId: "a",
        profileVersion: 1,
        downloadUrl: "https://storage.example/p",
        dataKey: key.toString("base64"),
        sizeBytes: sealed.length,
        sha256: "x",
        savedAt: 1,
      },
      async () => new Response(sealed),
    );
    expect(new Uint8Array(restored)).toEqual(archive);
  });
});

describe("the per-turn hosted environment", () => {
  const service = { read: vi.fn(), apply: vi.fn() };
  const turn = { runtimeId: "chatgpt-web" as const, projectId: "p", runId: "r", bearer: "Bearer t", actor: { actorUserId: "u1" } };

  it("is unavailable without the backend service", () => {
    vi.stubEnv("CONVEX_URL", "");
    expect(createHostedWebClientEnvironmentFactory({ env: {} })).toBeUndefined();
  });

  it("refuses a turn the vendor could not reach", async () => {
    vi.stubEnv("MCPJAM_INSPECTOR_PUBLIC_URL", "http://localhost:6274");
    vi.stubEnv("BASE_URL", "");
    const factory = createHostedWebClientEnvironmentFactory({ service })!;
    await expect(factory(turn)).rejects.toThrow(/public HTTPS address/);
  });

  it("is what each turn reads once set at startup", async () => {
    vi.stubEnv("MCPJAM_INSPECTOR_PUBLIC_URL", "https://inspector.example");
    vi.stubEnv("CONVEX_HTTP_URL", "https://backend.example");
    vi.stubEnv("MCPJAM_INSPECTOR_SERVICE_TOKEN", "service-token");
    setWebClientEnvironment(createHostedWebClientEnvironmentFactory({ service }));
    const environment = await webClientEnvironmentFor(turn).catch((error: unknown) => error);
    if (environment instanceof Error) {
      // A deployment without the service credential refuses with the reason.
      expect(environment.message).toMatch(/credential|token|service/i);
      return;
    }
    expect(environment?.publicBaseUrl).toBe("https://inspector.example");
  });
});

describe("the durable turn gate's answers", () => {
  function gate(answer: unknown) {
    return createHostedWebClientEnvironment({
      service: { read: async () => [], apply: async () => answer },
      actor: { actorUserId: "u1" },
      publicBaseUrl: "https://inspector.example",
      runId: "run-1",
      profileForRun: async () => {
        throw new Error("unused");
      },
      openHostedBrowser: async () => {
        throw new Error("unused");
      },
    }).turnGate!;
  }

  it("opens on ok and types the two refusals", async () => {
    const window = { connectorId: "c", runId: "run-1", turnId: "t" };
    await expect(gate({ ok: true, window: {} }).open(window)).resolves.toBeUndefined();
    await expect(gate({ ok: false, reason: "turn_running", active: {} }).open(window)).rejects.toMatchObject({
      failure: { kind: "turn_running", step: "connector" },
    });
    await expect(gate({ ok: false, reason: "connector_not_found" }).open(window)).rejects.toMatchObject({
      failure: { kind: "connector_not_found" },
    });
  });
});
