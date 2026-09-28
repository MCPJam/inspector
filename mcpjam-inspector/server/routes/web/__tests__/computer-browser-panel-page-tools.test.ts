/**
 * `GET /page-tools` — the Tools pane's read of the hosted browser's page.
 *
 * What these hold in place:
 *
 *   - the same token gate as every other panel route (it reads a live page, so
 *     it is not less sensitive than watching one);
 *   - it READS, it never starts: no browser ⇒ 409, and no attach;
 *   - the observation goes out as `inspector`, so the lease refuses it while
 *     somebody else is driving — EXCEPT for the person holding the lease, whose
 *     read is re-sent as their own `manual` command. Someone signing in should
 *     still be able to see what the page offers;
 *   - a read never counts as activity: a panel polling a tool list must not
 *     hold a metered box awake.
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

const OBSERVATION = {
  status: "ok" as const,
  bootId: "boot-1",
  result: {
    ok: true,
    output: {
      url: "https://webmcp.dev/",
      webmcpSupported: true,
      tools: [{ name: "bookSlot", description: "Reserve a slot" }],
    },
  },
};

function build(
  over: Partial<BrowserPanelDeps> = {},
  opts: {
    lease?: () => Promise<unknown>;
    sendCommand?: (command: unknown, bootId?: string) => Promise<unknown>;
  } = {},
) {
  const lease = vi.fn(
    opts.lease ?? (async () => ({ state: "free" as const, bootId: "boot-1" })),
  );
  const sendCommand = vi.fn(opts.sendCommand ?? (async () => OBSERVATION));
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
    createClient: () =>
      ({
        lease,
        sendCommand,
        leaseAction: vi.fn(),
        sendInput: vi.fn(),
      } as never),
    ...over,
  });

  const call = (path: string, auth: string | null = "tok") => {
    const headers = new Headers();
    if (auth !== null) headers.set("authorization", `Bearer ${auth}`);
    return app.request(`http://local${path}`, { headers });
  };

  const post = (
    path: string,
    body: unknown,
    auth: string | null = "tok",
  ) => {
    const headers = new Headers();
    if (auth !== null) headers.set("authorization", `Bearer ${auth}`);
    headers.set("content-type", "application/json");
    return app.request(`http://local${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  };

  return {
    call,
    post,
    sendCommand,
    lease,
    attachSession,
    touchSession,
    touchActivity,
  };
}

beforeEach(() => {
  resetPanelActivityThrottleForTests();
});

describe("GET /page-tools", () => {
  it("401s without a valid browser token", async () => {
    const { call, sendCommand } = build({
      verifyToken: (async () => null) as BrowserPanelDeps["verifyToken"],
    });
    const res = await call("/page-tools");
    expect(res.status).toBe(401);
    // Nothing was asked of the daemon on the way to the refusal.
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("returns the page's tools, read as an inspector observation", async () => {
    const { call, sendCommand } = build();
    const res = await call("/page-tools");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      url: "https://webmcp.dev/",
      webmcpSupported: true,
      tools: [{ name: "bookSlot", description: "Reserve a slot" }],
    });
    const [command] = sendCommand.mock.calls[0] as [
      { source: string; action: unknown },
    ];
    expect(command.source).toBe("inspector");
    expect(command.action).toEqual({ kind: "observe", mode: "webmcp_tools" });
  });

  it("answers 409 without starting a browser", async () => {
    // A tool list appearing in a side panel must never be what provisions a
    // machine — `/session?ensure=1` is the one route allowed to attach.
    const { call, attachSession, sendCommand } = build({
      lookupSession: (async () => ({
        reachable: true,
        session: null,
      })) as unknown as BrowserPanelDeps["lookupSession"],
    });
    const res = await call("/page-tools");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      ok: false,
      error: "no_browser_session",
    });
    expect(attachSession).not.toHaveBeenCalled();
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("reports a held lease as a pause, not a fault", async () => {
    const { call } = build(
      {},
      {
        sendCommand: async () => ({
          status: "lease_blocked" as const,
          lease: "held" as const,
          holder: "users_SOMEONE_ELSE",
          bootId: "boot-1",
        }),
        lease: async () => ({
          state: "held" as const,
          holder: "users_SOMEONE_ELSE",
          holderKind: "human" as const,
          bootId: "boot-1",
        }),
      },
    );
    const res = await call("/page-tools");
    expect(res.status).toBe(423);
    expect(await res.json()).toEqual({ ok: false, error: "lease_held" });
  });

  it("lets the lease HOLDER read the page, as their own manual command", async () => {
    // The common handoff is a login. Someone who took the browser to sign in
    // is exactly the person who then wants to see what the page now offers,
    // and the daemon admits a `manual` command that names the live holder.
    const responses = [
      {
        status: "lease_blocked" as const,
        lease: "held" as const,
        holder: CLAIMS.userId,
        bootId: "boot-1",
      },
      OBSERVATION,
    ];
    const { call, sendCommand } = build(
      {},
      {
        sendCommand: async () => responses.shift(),
        lease: async () => ({
          state: "held" as const,
          holder: CLAIMS.userId,
          holderKind: "human" as const,
          bootId: "boot-1",
        }),
      },
    );
    const res = await call("/page-tools");
    expect(res.status).toBe(200);
    expect(sendCommand).toHaveBeenCalledTimes(2);
    const [retry] = sendCommand.mock.calls[1] as [
      { source: string; holder?: string },
    ];
    expect(retry.source).toBe("manual");
    // The AUTHENTICATED user, never a client-supplied string: the daemon
    // checks this against the live lease, and a holder read off a request
    // would let anyone who echoed the right id observe a login in progress.
    expect(retry.holder).toBe(CLAIMS.userId);
  });

  it("does not retry as manual when somebody else holds the lease", async () => {
    const { call, sendCommand } = build(
      {},
      {
        sendCommand: async () => ({
          status: "lease_blocked" as const,
          lease: "held" as const,
          bootId: "boot-1",
        }),
        lease: async () => ({
          state: "held" as const,
          holder: "users_SOMEONE_ELSE",
          holderKind: "human" as const,
          bootId: "boot-1",
        }),
      },
    );
    expect((await call("/page-tools")).status).toBe(423);
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it("never counts a read as activity", async () => {
    // Reading a tool list is not using the machine. Counted, a Tools panel
    // left open would hold a metered box awake indefinitely.
    const { call, touchSession, touchActivity } = build();
    expect((await call("/page-tools")).status).toBe(200);
    expect(touchSession).not.toHaveBeenCalled();
    expect(touchActivity).not.toHaveBeenCalled();
  });

  it("passes a named tab through to the daemon", async () => {
    const { call, sendCommand } = build();
    await call("/page-tools?tabId=tab-2");
    const [command] = sendCommand.mock.calls[0] as [{ tabId?: string }];
    expect(command.tabId).toBe("tab-2");
  });
});

const INVOKE_OK = {
  status: "ok" as const,
  bootId: "boot-1",
  result: { ok: true, output: { added: "pepperoni" } },
};

describe("POST /page-tools/invoke", () => {
  it("401s without a valid browser token", async () => {
    const { post, sendCommand } = build({
      verifyToken: (async () => null) as BrowserPanelDeps["verifyToken"],
    });
    const res = await post("/page-tools/invoke", { toolKey: "add_topping" });
    expect(res.status).toBe(401);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("goes out as inspector while the agent is driving, never with a body-supplied source", async () => {
    const { post, sendCommand } = build(
      {},
      { sendCommand: async () => INVOKE_OK },
    );
    const res = await post("/page-tools/invoke", {
      toolKey: "add_topping",
      source: "agent",
      input: { topping: "pepperoni" },
      frameId: "frame-main",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      output: { added: "pepperoni" },
    });
    expect(sendCommand).toHaveBeenCalledTimes(1);
    const [command] = sendCommand.mock.calls[0] as [
      {
        source: string;
        holder?: string;
        action: { kind: string; toolKey: string; input: unknown };
      },
    ];
    expect(command.source).toBe("inspector");
    expect(command.holder).toBeUndefined();
    expect(command.action).toMatchObject({
      kind: "webmcp_invoke",
      toolKey: "add_topping",
      input: { topping: "pepperoni" },
    });
  });

  it("retries as this person's manual command when they hold the lease", async () => {
    const { post, sendCommand } = build(
      {},
      {
        sendCommand: async (command) => {
          const source = (command as { source?: string }).source;
          if (source === "inspector") {
            return {
              status: "lease_blocked",
              lease: "held",
              bootId: "boot-1",
            };
          }
          return INVOKE_OK;
        },
      },
    );
    const res = await post("/page-tools/invoke", { toolKey: "add_topping" });
    expect(res.status).toBe(200);
    expect(sendCommand).toHaveBeenCalledTimes(2);
    expect(
      (sendCommand.mock.calls[1][0] as { source: string; holder?: string }),
    ).toMatchObject({ source: "manual", holder: CLAIMS.userId });
  });

  it("counts an invoke as activity, unlike the read", async () => {
    const { post, touchSession, touchActivity } = build(
      {},
      { sendCommand: async () => INVOKE_OK },
    );
    expect(
      (await post("/page-tools/invoke", { toolKey: "add_topping" })).status,
    ).toBe(200);
    expect(touchSession).toHaveBeenCalled();
    expect(touchActivity).toHaveBeenCalled();
  });

  it("409s when nothing is running", async () => {
    const { post, sendCommand } = build({
      lookupSession: (async () => ({
        reachable: true,
        session: null,
      })) as unknown as BrowserPanelDeps["lookupSession"],
    });
    const res = await post("/page-tools/invoke", { toolKey: "add_topping" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      ok: false,
      error: "no_browser_session",
    });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("400s without a toolKey", async () => {
    const { post, sendCommand } = build();
    const res = await post("/page-tools/invoke", { input: {} });
    expect(res.status).toBe(400);
    expect(sendCommand).not.toHaveBeenCalled();
  });
});
