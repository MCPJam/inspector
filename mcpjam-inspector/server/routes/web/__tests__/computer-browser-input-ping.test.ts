/**
 * POST /input-ping: VNC input never passes the relay, so the pane reports it,
 * and the route counts it as a command (which watching never is). Its own
 * file because the computer-activity throttle is module state.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createComputerBrowserPanelRoutes,
  type BrowserPanelDeps,
} from "../computer-browser-panel";

const CLAIMS = {
  userId: "users_1",
  computerId: "computers_1",
  projectId: "projects_1",
};

const SESSION = {
  sessionId: "sessions_1",
  computerId: "computers_1",
  bootId: "boot-1",
  browserdToken: "daemon-secret",
  browserdPort: 8791,
  publicOrigin: "https://box-8791.e2b.dev",
  streamUrl: "https://box-6080.e2b.dev/vnc.html",
  streamPassword: "stream-pw",
  bundleHash: "hash-1",
  contextMode: "persistent" as const,
  idleMs: 300_000,
};

function build(over: Partial<BrowserPanelDeps> = {}) {
  const touchSession = vi.fn(async () => ({ counted: true }));
  const touchActivity = vi.fn(async () => {});
  const app = createComputerBrowserPanelRoutes({
    configured: () => true,
    verifyToken: (async (token: string) =>
      token === "tok" ? CLAIMS : null) as BrowserPanelDeps["verifyToken"],
    sandboxInfo: (async () => ({
      ok: true,
      value: {
        ownerUserId: CLAIMS.userId,
        projectId: CLAIMS.projectId,
        providerComputerId: "sbx_1",
        status: "ready",
      },
    })) as unknown as BrowserPanelDeps["sandboxInfo"],
    lookupSession: (async () => ({
      reachable: true,
      session: SESSION,
    })) as unknown as BrowserPanelDeps["lookupSession"],
    touchSession: touchSession as unknown as BrowserPanelDeps["touchSession"],
    touchActivity:
      touchActivity as unknown as BrowserPanelDeps["touchActivity"],
    bundleHash: () => "hash-1",
    createClient: () =>
      ({
        lease: async () => ({ state: "free" as const, bootId: "boot-1" }),
        status: async () => ({ kind: "ok", bootId: SESSION.bootId }),
      }) as never,
    ...over,
  });
  const call = (path: string, init: RequestInit & { auth?: string } = {}) =>
    app.request(`http://local${path}`, {
      ...init,
      headers: { authorization: `Bearer ${init.auth ?? "tok"}` },
    });
  return { call, touchSession, touchActivity };
}

describe("browser panel — POST /input-ping", () => {
  it("counts VNC input as a command, and keeps the computer awake", async () => {
    const { call, touchSession, touchActivity } = build();
    const res = await call("/input-ping", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, counted: true });
    expect(touchSession).toHaveBeenCalledWith({
      sessionId: SESSION.sessionId,
      kind: "command",
    });
    expect(touchActivity).toHaveBeenCalledWith({
      computerId: CLAIMS.computerId,
    });
  });

  it("refuses without a valid token, and 409s with no browser to count", async () => {
    expect(
      (await build().call("/input-ping", { method: "POST", auth: "bad" }))
        .status,
    ).toBe(401);
    const { call, touchSession } = build({
      lookupSession: (async () => ({
        reachable: true,
        session: null,
      })) as unknown as BrowserPanelDeps["lookupSession"],
    });
    expect((await call("/input-ping", { method: "POST" })).status).toBe(409);
    expect(touchSession).not.toHaveBeenCalled();
  });

  it("answers 502 when the control plane cannot record it", async () => {
    const { call } = build({
      touchSession: (async () => {
        throw new Error("control plane down");
      }) as unknown as BrowserPanelDeps["touchSession"],
    });
    expect((await call("/input-ping", { method: "POST" })).status).toBe(502);
  });
});

describe("browser panel — GET /session", () => {
  it("passes on the box's idle window, for the paused overlay's copy", async () => {
    const res = await build().call("/session");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ idleMs: 300_000 });
  });
});
