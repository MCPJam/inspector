/**
 * The Browser Panel data plane. What these tests hold in place:
 *
 *   - the panel is reachable ONLY with a valid browser token whose claims still
 *     match the row's live owner and project;
 *   - watching does not require holding the lease (L10) — the stream URL comes
 *     back whoever has the browser;
 *   - the lease holder is the authenticated user, never a client-supplied
 *     string;
 *   - the panel ATTACHES, it never reserves — someone opening a panel cannot
 *     provision a machine.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  createComputerBrowserPanelRoutes,
  resetPanelActivityThrottleForTests,
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
};

function build(over: Partial<BrowserPanelDeps> = {}) {
  const leaseAction = vi.fn(async () => ({
    took: true,
    lease: { state: "held" as const, holder: CLAIMS.userId, bootId: "boot-1" },
  }));
  const lease = vi.fn(async () => ({
    state: "free" as const,
    bootId: "boot-1",
  }));
  const attachSession = vi.fn(async () => {});
  const touchSession = vi.fn(async () => ({ counted: true }));
  const touchActivity = vi.fn(async () => {});
  const lookupSession = vi.fn(async () => ({
    reachable: true,
    session: SESSION,
  }));

  const app = createComputerBrowserPanelRoutes({
    configured: () => true,
    verifyToken: (async () => CLAIMS) as BrowserPanelDeps["verifyToken"],
    sandboxInfo: (async () => ({
      ok: true,
      value: {
        ownerUserId: CLAIMS.userId,
        projectId: CLAIMS.projectId,
        providerComputerId: "sbx_1",
      },
    })) as unknown as BrowserPanelDeps["sandboxInfo"],
    lookupSession:
      lookupSession as unknown as BrowserPanelDeps["lookupSession"],
    touchSession: touchSession as unknown as BrowserPanelDeps["touchSession"],
    touchActivity:
      touchActivity as unknown as BrowserPanelDeps["touchActivity"],
    bundleHash: () => "hash-1",
    attachSession,
    createClient: () => ({ lease, leaseAction }) as never,
    ...over,
  });

  const call = (
    path: string,
    init: RequestInit & { auth?: string | null } = {},
  ) => {
    const headers = new Headers(init.headers);
    if (init.auth !== null) {
      headers.set("authorization", `Bearer ${init.auth ?? "tok"}`);
    }
    return app.request(`http://local${path}`, { ...init, headers });
  };

  return {
    call,
    lease,
    leaseAction,
    attachSession,
    touchSession,
    touchActivity,
    lookupSession,
  };
}

beforeEach(() => {
  resetPanelActivityThrottleForTests();
});

describe("browser panel — auth", () => {
  it("401s an invalid or missing token, with one message for every rejection", async () => {
    const { call } = build({
      verifyToken: (async () => null) as BrowserPanelDeps["verifyToken"],
    });
    for (const path of ["/session", "/lease", "/keepalive"]) {
      const res = await call(path, {
        method: path === "/session" ? "GET" : "POST",
        body:
          path === "/session"
            ? undefined
            : JSON.stringify({ action: "acquire" }),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({
        error: "Invalid or expired browser token.",
      });
    }
  });

  it("401s a token whose claims no longer match the row's owner", async () => {
    // The mint authorized this ~60s ago; ownership can change inside that
    // window, and the panel shows a live screen.
    const { call } = build({
      sandboxInfo: (async () => ({
        ok: true,
        value: {
          ownerUserId: "users_SOMEONE_ELSE",
          projectId: CLAIMS.projectId,
          providerComputerId: "sbx_1",
        },
      })) as unknown as BrowserPanelDeps["sandboxInfo"],
    });
    expect((await call("/session")).status).toBe(401);
  });

  it("401s a token minted for another project", async () => {
    const { call } = build({
      sandboxInfo: (async () => ({
        ok: true,
        value: {
          ownerUserId: CLAIMS.userId,
          projectId: "projects_OTHER",
          providerComputerId: "sbx_1",
        },
      })) as unknown as BrowserPanelDeps["sandboxInfo"],
    });
    expect((await call("/session")).status).toBe(401);
  });

  it("503s when computers are not configured on this server", async () => {
    const { call } = build({ configured: () => false });
    expect((await call("/session")).status).toBe(503);
  });
});

describe("browser panel — GET /session", () => {
  it("returns the session and who holds the browser", async () => {
    const { call } = build();
    const res = await call("/session");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      bootId: "boot-1",
      lease: { state: "free" },
    });
  });

  it("NEVER returns the stream credentials", async () => {
    // They used to be here, and the panel put them straight into an iframe
    // `src`. The VNC password is full keyboard and mouse on the member's
    // desktop — the daemon's lease gates model commands, not VNC input — so
    // in the DOM it was a control credential readable by anything on the page.
    // The browser now watches through the server-side RFB proxy instead.
    const { call } = build();
    const body = await (await call("/session")).json();
    expect(body).not.toHaveProperty("streamUrl");
    expect(body).not.toHaveProperty("streamPassword");
    expect(JSON.stringify(body)).not.toContain(SESSION.streamPassword);
  });

  it("still returns the stream while someone else HOLDS the lease (L10)", async () => {
    // View by default. Gating the view behind "take control" would make people
    // take control just to look, which is the disruptive action.
    const { call } = build({
      createClient: () =>
        ({
          lease: async () => ({
            state: "held",
            holder: "users_other",
            bootId: "boot-1",
          }),
          leaseAction: async () => ({ took: false, lease: { state: "held" } }),
        }) as never,
    });
    const body = await (await call("/session")).json();
    expect(body.ok).toBe(true);
    expect(body.lease).toMatchObject({ state: "held", holder: "users_other" });
  });

  it("degrades to lease:unknown rather than failing when the daemon is unreachable", async () => {
    const { call } = build({
      createClient: () =>
        ({
          lease: async () => {
            throw new Error("connect ECONNREFUSED");
          },
          leaseAction: async () => ({ took: false, lease: { state: "free" } }),
        }) as never,
    });
    const res = await call("/session");
    expect(res.status).toBe(200);
    expect((await res.json()).lease).toEqual({ state: "unknown" });
  });

  it("409s with no session, and does NOT attach unless asked", async () => {
    const { call, attachSession } = build({
      lookupSession: (async () => ({
        reachable: true,
        session: null,
      })) as unknown as BrowserPanelDeps["lookupSession"],
    });
    const res = await call("/session");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("no_browser_session");
    expect(attachSession).not.toHaveBeenCalled();
  });

  it("attaches on ensure=1, then answers from the recorded row", async () => {
    let session: typeof SESSION | null = null;
    const lookupSession = vi.fn(async () => ({ reachable: true, session }));
    const attachSession = vi.fn(async () => {
      session = SESSION;
    });
    const { call } = build({
      lookupSession:
        lookupSession as unknown as BrowserPanelDeps["lookupSession"],
      attachSession,
    });
    const res = await call("/session?ensure=1");
    expect(res.status).toBe(200);
    expect(attachSession).toHaveBeenCalledOnce();
    // The row, not the attach's return value, is the source of truth — the
    // attach may have adopted another replica's session.
    expect(lookupSession).toHaveBeenCalledTimes(2);
  });
});

describe("browser panel — POST /lease", () => {
  it("names the AUTHENTICATED user as the holder, ignoring the body", async () => {
    // A client-chosen holder could hand back a lease it never took, resuming
    // the agent while someone else is still typing.
    const { call, leaseAction } = build();
    await call("/lease", {
      method: "POST",
      body: JSON.stringify({ action: "acquire", holder: "somebody-else" }),
    });
    expect(leaseAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "acquire", holder: CLAIMS.userId }),
    );
  });

  it("passes acquire / heartbeat / resume through and rejects anything else", async () => {
    const { call, leaseAction } = build();
    for (const action of ["acquire", "heartbeat", "resume"]) {
      const res = await call("/lease", {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      expect(res.status).toBe(200);
    }
    expect(leaseAction).toHaveBeenCalledTimes(3);

    for (const bad of [{ action: "steal" }, { action: 7 }, {}]) {
      const res = await call("/lease", {
        method: "POST",
        body: JSON.stringify(bad),
      });
      expect(res.status).toBe(400);
    }
    const malformed = await call("/lease", { method: "POST", body: "{nope" });
    expect(malformed.status).toBe(400);
    expect(leaseAction).toHaveBeenCalledTimes(3);
  });

  it("409s an acquire that did not take", async () => {
    const { call } = build({
      createClient: () =>
        ({
          lease: async () => ({ state: "free", bootId: "boot-1" }),
          leaseAction: async () => ({
            took: false,
            lease: { state: "held", holder: "users_other", bootId: "boot-1" },
          }),
        }) as never,
    });
    const res = await call("/lease", {
      method: "POST",
      body: JSON.stringify({ action: "acquire" }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      ok: false,
      lease: { holder: "users_other" },
    });
  });

  it("409s when there is no browser to take", async () => {
    const { call } = build({
      lookupSession: (async () => ({
        reachable: true,
        session: null,
      })) as unknown as BrowserPanelDeps["lookupSession"],
    });
    const res = await call("/lease", {
      method: "POST",
      body: JSON.stringify({ action: "acquire" }),
    });
    expect(res.status).toBe(409);
  });
});

describe("browser panel — POST /keepalive", () => {
  it("touches the session as a panel and reports whether it counted", async () => {
    const { call, touchSession, touchActivity } = build();
    const res = await call("/keepalive", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, counted: true });
    expect(touchSession).toHaveBeenCalledWith({
      sessionId: SESSION.sessionId,
      kind: "panel",
    });
    expect(touchActivity).toHaveBeenCalledOnce();
  });

  it("does NOT keep the machine awake once the backend stops counting the panel", async () => {
    // A tab left open over a weekend must not hold a computer running; the
    // ceiling lives server-side and this route obeys it.
    const { call, touchActivity } = build({
      touchSession: (async () => ({
        counted: false,
      })) as unknown as BrowserPanelDeps["touchSession"],
    });
    expect(await (await call("/keepalive", { method: "POST" })).json()).toEqual(
      {
        ok: true,
        counted: false,
      },
    );
    expect(touchActivity).not.toHaveBeenCalled();
  });

  it("throttles the computer-activity touch across rapid beats", async () => {
    const { call, touchActivity } = build();
    await call("/keepalive", { method: "POST" });
    await call("/keepalive", { method: "POST" });
    await call("/keepalive", { method: "POST" });
    expect(touchActivity).toHaveBeenCalledOnce();
  });

  it("409s when there is no session to keep alive", async () => {
    const { call } = build({
      lookupSession: (async () => ({
        reachable: true,
        session: null,
      })) as unknown as BrowserPanelDeps["lookupSession"],
    });
    expect((await call("/keepalive", { method: "POST" })).status).toBe(409);
  });
});
