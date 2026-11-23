/**
 * The hosted pieces without a hosted backend: the session transport over a
 * recorded daemon client, the restored profile, the per-turn environment's
 * refusals, and the turn gate's typed answers. Evidence: fixture.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import {
  exportWebAccountProfile,
  sessionBrowserTransport,
  webClientBrowserPolicy,
} from "../hosted-browser";
import { createHostedWebClientEnvironment } from "../hosted-web-client-environment";
import { createHostedWebClientEnvironmentFactory, restoreWebProfile } from "../hosted-web-client-runtime";
import { sealWebProfile } from "../recovery/profile-cipher";
import { setWebClientEnvironment, webClientEnvironmentFor } from "../web-client-environment";

afterEach(() => {
  vi.unstubAllEnvs();
  setWebClientEnvironment(undefined);
});

describe("the session transport", () => {
  const policy = webClientBrowserPolicy("chatgpt", []);
  const okResponse = {
    status: "ok" as const,
    result: { ok: true, output: { url: "https://chatgpt.com/" } },
    bootId: "boot-1",
  };

  /** The daemon's status, announcing `features`. */
  const statusWith = (features: string[]) =>
    vi.fn(async () => ({ kind: "ok" as const, bootId: "boot-1", features }));

  it("maps a page module's command onto the session's daemon", async () => {
    const sendCommand = vi.fn(async () => okResponse);
    const send = sessionBrowserTransport({
      handle: { client: { sendCommand, status: statusWith([]) }, bootId: "boot-1" },
      sessionId: "browser-session-1",
      policy,
    });
    const result = await send({ op: "act", verb: "click", target: { selector: "#send" }, observeAfter: "none" });
    expect(result).toMatchObject({ status: "executed", ok: true });
    expect(sendCommand).toHaveBeenCalledTimes(2);
    for (const call of sendCommand.mock.calls) {
      expect(call).toEqual([expect.objectContaining({ responsiveViewport: true }), "boot-1"]);
    }
    expect(sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "agent",
        sessionId: "browser-session-1",
        action: expect.objectContaining({ kind: "act", verb: "click" }),
      }),
      "boot-1",
    );
  });

  it("keeps coordinate actions on a fixed viewport", async () => {
    const sendCommand = vi.fn(async () => okResponse);
    const send = sessionBrowserTransport({
      handle: { client: { sendCommand, status: statusWith([]) }, bootId: "boot-1" },
      sessionId: "s",
      policy,
    });
    await send({ op: "act", verb: "click", target: { coordinates: [10, 10] } });
    expect(sendCommand).toHaveBeenLastCalledWith(expect.objectContaining({ responsiveViewport: false }), "boot-1");
  });

  it("refuses another site before the daemon and reports a lost command as unknown", async () => {
    const sendCommand = vi.fn(async (command: { action: { kind: string } }) => {
      if (command.action.kind === "observe") return okResponse;
      throw new Error("socket closed");
    });
    const send = sessionBrowserTransport({
      handle: { client: { sendCommand, status: statusWith([]) }, bootId: "boot-1" },
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

  it("reads one element's text only from a daemon that says it can", async () => {
    // An older daemon ignores `rootSelector` on a text read and answers with
    // the whole page's text, which a page module would take for the element's.
    const read = { op: "observe", mode: "text", rootSelector: "role=dialog" } as const;
    const sendCommand = vi.fn(async () => okResponse);
    const older = statusWith(["navigation-stop"]);
    const send = sessionBrowserTransport({
      handle: { client: { sendCommand, status: older }, bootId: "boot-1" },
      sessionId: "s",
      policy,
    });
    expect(await send(read)).toMatchObject({
      status: "refused",
      refusal: { code: "unsupported_target" },
    });
    expect(await send({ op: "observe", mode: "text" })).toMatchObject({ status: "executed" });
    expect(sendCommand).toHaveBeenCalledTimes(1);

    const current = statusWith(["element-text"]);
    const upToDate = sessionBrowserTransport({
      handle: { client: { sendCommand, status: current }, bootId: "boot-1" },
      sessionId: "s",
      policy,
    });
    expect(await upToDate(read)).toMatchObject({ status: "executed", ok: true });
    expect(await upToDate(read)).toMatchObject({ status: "executed", ok: true });
    expect(sendCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: { kind: "observe", mode: "text", rootSelector: "role=dialog" },
      }),
      "boot-1",
    );
    // Asked once per browser, not once per read.
    expect(current).toHaveBeenCalledTimes(1);

    // A daemon that didn't answer is asked again rather than taken as either.
    const silent = vi.fn(async () => {
      throw new Error("socket closed");
    });
    const unsure = sessionBrowserTransport({
      handle: { client: { sendCommand, status: silent }, bootId: "boot-1" },
      sessionId: "s",
      policy,
    });
    expect(await unsure(read)).toMatchObject({ status: "refused" });
    expect(await unsure(read)).toMatchObject({ status: "refused" });
    expect(silent).toHaveBeenCalledTimes(2);
  });

  it("sends nothing that could change a page off the vendor's sites, until a navigate brings it back", async () => {
    let page: string | Error = "https://elsewhere.example/";
    const sendCommand = vi.fn(async (_command: { action: { kind: string } }) => {
      if (page instanceof Error) throw page;
      return { status: "ok" as const, result: { ok: true, output: { url: page } }, bootId: "boot-1" };
    });
    const send = sessionBrowserTransport({
      handle: { client: { sendCommand, status: statusWith([]) }, bootId: "boot-1" },
      sessionId: "s",
      policy,
    });
    const typed = { op: "act", verb: "type", target: { selector: "#prompt" }, value: "the prompt" } as const;
    for (const command of [typed, { op: "act", verb: "press", value: "Enter" } as const]) {
      expect(await send(command)).toMatchObject({ status: "refused", refusal: { code: "origin_not_allowed" } });
    }
    // A page the browser can't place counts as off the sites.
    page = new Error("socket closed");
    expect(await send(typed)).toMatchObject({ status: "refused", refusal: { code: "origin_not_allowed" } });
    expect(sendCommand.mock.calls.map(([command]) => command.action.kind)).toEqual(["observe", "observe", "observe"]);

    page = "https://chatgpt.com/";
    expect(await send({ op: "navigate", url: "https://chatgpt.com/" })).toMatchObject({ status: "executed", ok: true });
    expect(await send(typed)).toMatchObject({ status: "executed", ok: true });
    expect(sendCommand.mock.calls.slice(3).map(([command]) => command.action.kind)).toEqual([
      "navigate",
      "observe",
      "act",
    ]);
  });

  it("keeps each vendor's browser to its own sites and MCPJam's sign-in page", () => {
    expect(webClientBrowserPolicy("claude", [])).toEqual({ mode: "allowlist", originAllowlist: ["https://claude.ai"] });
    expect(webClientBrowserPolicy("chatgpt", ["https://signin.example"]).originAllowlist).toEqual([
      "https://chatgpt.com",
      "https://auth.openai.com",
      "https://signin.example",
    ]);
  });
});

describe("saving a web account's profile", () => {
  const statusWith = (features: string[]) =>
    vi.fn(async () => ({ kind: "ok" as const, bootId: "boot-1", features }));
  const archive = new Uint8Array([31, 139]);

  it("leaves MCPJam's sign-in page out of the archive, and keeps the vendor's sites", async () => {
    const exportProfile = vi.fn(async () => archive);
    const saved = await exportWebAccountProfile({
      client: { exportProfile, status: statusWith(["profile-export-exclusions"]) },
      policy: webClientBrowserPolicy("chatgpt", ["https://signin.example"]),
      vendor: "chatgpt",
    });
    expect(saved).toBe(archive);
    expect(exportProfile).toHaveBeenCalledWith({ excludeOrigins: ["https://signin.example"] });
  });

  it("saves nothing from a browser that would keep the sign-in session", async () => {
    const exportProfile = vi.fn(async () => archive);
    await expect(
      exportWebAccountProfile({
        client: { exportProfile, status: statusWith(["element-text"]) },
        policy: webClientBrowserPolicy("chatgpt", ["https://signin.example"]),
        vendor: "chatgpt",
      }),
    ).rejects.toThrow("can't save the account yet");
    expect(exportProfile).not.toHaveBeenCalled();
  });

  it("asks nothing more of a browser with no other site to leave out", async () => {
    const exportProfile = vi.fn(async () => archive);
    await exportWebAccountProfile({
      client: { exportProfile, status: statusWith([]) },
      policy: webClientBrowserPolicy("claude", []),
      vendor: "claude",
    });
    expect(exportProfile).toHaveBeenCalledWith({ excludeOrigins: [] });
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
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token-for-tests");
    setWebClientEnvironment(createHostedWebClientEnvironmentFactory({ service }));
    const environment = await webClientEnvironmentFor(turn);
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

  it("stops the turn on a reply it can't read, never opening it ungated", async () => {
    const window = { connectorId: "c", runId: "run-1", turnId: "t" };
    for (const answer of [undefined, null, { ok: "yes" }, { ok: false, reason: "paused" }]) {
      await expect(gate(answer).open(window)).rejects.toMatchObject({
        failure: { kind: "driver", step: "connector" },
      });
    }
  });
});
