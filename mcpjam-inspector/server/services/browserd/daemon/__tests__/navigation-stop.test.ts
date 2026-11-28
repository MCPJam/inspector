/**
 * A command can stop a top-level navigation to a page before it is sent and
 * get back the URL it asked for. A readiness run stops at MCPJam's OAuth
 * callback this way, so the app there never loads and never moves the code
 * out of the address bar first, and the URL reaches the caller alone: the
 * ledger never records it.
 */
import { describe, expect, it, vi } from "vitest";
import { armNavigationStop, isStopTarget } from "../navigation-stop";
import { ChromiumDriver } from "../chromium-driver";
import { BrowserdRequestHandler } from "../request-handler";
import { CommandLedger } from "../command-ledger";
import { HandoffLease } from "../lease";
import { BROWSERD_WEBMCP_FEATURES } from "../../protocol";
import type { BrowserCommand } from "../../protocol";
import { fakeCdpSession, fakeContext, fakePage } from "./fake-page";

const CALLBACK = "https://app.mcpjam.com/oauth/callback";
const CODE = "code-sample-123";
const STATE = "state-sample-456";
const ANSWER = `${CALLBACK}?code=${CODE}&state=${STATE}`;
const CONSENT = "https://acme.authkit.app/consent";

const paused = (url: string, frameId = "main") => ({
  requestId: "r1",
  frameId,
  resourceType: "Document",
  request: { url },
});

function session() {
  return fakeCdpSession({
    "Page.getFrameTree": { frameTree: { frame: { id: "main" } } },
  });
}

type Session = ReturnType<typeof session>;
const sent = (cdp: Session, method: string) =>
  cdp.sent.filter((call) => call.method === method);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("armNavigationStop", () => {
  it("fails the main frame's request for the page and hands back its full URL", async () => {
    const cdp = session();
    const stop = await armNavigationStop(cdp, CALLBACK);
    expect(sent(cdp, "Fetch.enable")[0]!.params).toEqual({
      patterns: [
        {
          urlPattern: `${CALLBACK}*`,
          resourceType: "Document",
          requestStage: "Request",
        },
      ],
    });

    cdp.emit("Fetch.requestPaused", paused(ANSWER));
    await flush();

    expect(sent(cdp, "Fetch.failRequest")).toEqual([
      {
        method: "Fetch.failRequest",
        params: { requestId: "r1", errorReason: "Aborted" },
      },
    ]);
    expect(stop.stopped()).toBe(ANSWER);
    await stop.disarm();
    expect(sent(cdp, "Fetch.disable")).toHaveLength(1);
  });

  it.each([
    [
      "a longer path that shares the prefix",
      `${CALLBACK}/debug?code=c`,
      "main",
    ],
    ["the page in a child frame", ANSWER, "child"],
  ])("lets %s go on", async (_label, url, frameId) => {
    const cdp = session();
    const stop = await armNavigationStop(cdp, CALLBACK);
    cdp.emit("Fetch.requestPaused", paused(url, frameId));
    await flush();
    expect(sent(cdp, "Fetch.continueRequest")).toEqual([
      { method: "Fetch.continueRequest", params: { requestId: "r1" } },
    ]);
    expect(sent(cdp, "Fetch.failRequest")).toEqual([]);
    expect(stop.stopped()).toBeUndefined();
  });

  it("ends cleanly when nothing navigated there, and stops nothing after", async () => {
    const cdp = session();
    const stop = await armNavigationStop(cdp, CALLBACK);
    await stop.disarm();
    // A straggler paused before the disable landed must not hang the page.
    cdp.emit("Fetch.requestPaused", paused(ANSWER));
    await flush();
    expect(stop.stopped()).toBeUndefined();
    expect(sent(cdp, "Fetch.disable")).toHaveLength(1);
    expect(sent(cdp, "Fetch.continueRequest")).toHaveLength(1);
    expect(sent(cdp, "Fetch.failRequest")).toEqual([]);
  });

  describe("behind the egress proxy", () => {
    const PROXY = { username: "browser", password: "proxy-secret-sample" };
    const challenge = (source: "Proxy" | "Server", requestId = "a1") => ({
      requestId,
      request: { url: `${CONSENT}?x=1` },
      authChallenge: { source, origin: "http://127.0.0.1:9", scheme: "basic" },
    });

    it("pauses every request and handles auth, so the proxy's challenge reaches this session", async () => {
      const cdp = session();
      await armNavigationStop(cdp, CALLBACK, PROXY);
      expect(sent(cdp, "Fetch.enable")[0]!.params).toEqual({
        handleAuthRequests: true,
        patterns: [{ urlPattern: "*", requestStage: "Request" }],
      });
    });

    it("answers the proxy once with its credentials, and cancels a second ask", async () => {
      const cdp = session();
      await armNavigationStop(cdp, CALLBACK, PROXY);
      cdp.emit("Fetch.authRequired", challenge("Proxy"));
      cdp.emit("Fetch.authRequired", challenge("Proxy"));
      await flush();
      expect(sent(cdp, "Fetch.continueWithAuth")).toEqual([
        {
          method: "Fetch.continueWithAuth",
          params: {
            requestId: "a1",
            authChallengeResponse: {
              response: "ProvideCredentials",
              username: PROXY.username,
              password: PROXY.password,
            },
          },
        },
        {
          method: "Fetch.continueWithAuth",
          params: {
            requestId: "a1",
            authChallengeResponse: { response: "CancelAuth" },
          },
        },
      ]);
    });

    it("never offers the proxy's credentials to a site", async () => {
      const cdp = session();
      await armNavigationStop(cdp, CALLBACK, PROXY);
      cdp.emit("Fetch.authRequired", challenge("Server"));
      await flush();
      expect(sent(cdp, "Fetch.continueWithAuth")).toEqual([
        {
          method: "Fetch.continueWithAuth",
          params: {
            requestId: "a1",
            authChallengeResponse: { response: "CancelAuth" },
          },
        },
      ]);
    });

    it("stops only the main frame's document, now that it sees every request", async () => {
      const cdp = session();
      const stop = await armNavigationStop(cdp, CALLBACK, PROXY);
      cdp.emit("Fetch.requestPaused", {
        ...paused(ANSWER),
        resourceType: "XHR",
      });
      await flush();
      expect(sent(cdp, "Fetch.failRequest")).toEqual([]);
      expect(stop.stopped()).toBeUndefined();
      cdp.emit("Fetch.requestPaused", paused(ANSWER));
      await flush();
      expect(stop.stopped()).toBe(ANSWER);
    });

    it("cancels challenges once the browser has no proxy", async () => {
      const cdp = session();
      const first = await armNavigationStop(cdp, CALLBACK, PROXY);
      await first.disarm();
      await armNavigationStop(cdp, CALLBACK);
      cdp.emit("Fetch.authRequired", challenge("Proxy", "a2"));
      await flush();
      expect(sent(cdp, "Fetch.continueWithAuth")).toEqual([
        {
          method: "Fetch.continueWithAuth",
          params: {
            requestId: "a2",
            authChallengeResponse: { response: "CancelAuth" },
          },
        },
      ]);
    });
  });

  it.each([
    [CALLBACK, true],
    [`${CALLBACK}?step=1`, false],
    ["https://app.mcpjam.com/oauth/*", false],
    ["ftp://files.example/callback", false],
    ["not a url", false],
    [7, false],
  ])("isStopTarget(%j) is %s", (value, expected) => {
    expect(isStopTarget(value)).toBe(expected);
  });
});

describe("a command that stops at a page", () => {
  const click = (stopAt?: string): BrowserCommand => ({
    commandId: `c-${Math.random()}`,
    source: "inspector",
    action: {
      kind: "act",
      verb: "click",
      target: { selector: "#allow" },
      observe: "none",
    },
    ...(stopAt ? { stopAt } : {}),
  });

  async function stack() {
    const page = fakePage({ url: CONSENT });
    const cdp = session();
    page.cdpSession = cdp;
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute({
      commandId: "nav",
      source: "inspector",
      action: { kind: "navigate", url: CONSENT },
    });
    return { page, cdp, driver };
  }

  it("stops the redirect the act caused, and returns its URL beside the result", async () => {
    const { page, cdp, driver } = await stack();
    page.onAct = () => cdp.emit("Fetch.requestPaused", paused(ANSWER));

    const result = await driver.execute(click(CALLBACK));

    expect(result.stoppedAt).toBe(ANSWER);
    expect(JSON.stringify(result.output ?? {})).not.toContain(CODE);
    expect(sent(cdp, "Fetch.failRequest")).toHaveLength(1);
    expect(sent(cdp, "Fetch.disable")).toHaveLength(1);
  });

  it("returns no URL when the act went nowhere, and lets go of the page", async () => {
    const { cdp, driver } = await stack();
    const result = await driver.execute(click(CALLBACK));
    expect(result.stoppedAt).toBeUndefined();
    expect(sent(cdp, "Fetch.enable")).toHaveLength(1);
    expect(sent(cdp, "Fetch.disable")).toHaveLength(1);
  });

  it("arms the stop with the browser's egress proxy credentials", async () => {
    const page = fakePage({ url: CONSENT });
    const cdp = session();
    page.cdpSession = cdp;
    const { context } = fakeContext({ pages: [page] });
    const proxyAuth = { username: "browser", password: "proxy-secret-sample" };
    const driver = new ChromiumDriver({ ...context, proxyAuth });
    await driver.execute({
      commandId: "nav",
      source: "inspector",
      action: { kind: "navigate", url: CONSENT },
    });

    await driver.execute({ ...click(CALLBACK), stopAtPersistent: true });
    cdp.emit("Fetch.authRequired", {
      requestId: "a1",
      authChallenge: { source: "Proxy" },
    });
    await flush();

    expect(sent(cdp, "Fetch.enable")[0]!.params).toMatchObject({
      handleAuthRequests: true,
    });
    expect(sent(cdp, "Fetch.continueWithAuth")[0]!.params).toEqual({
      requestId: "a1",
      authChallengeResponse: { response: "ProvideCredentials", ...proxyAuth },
    });
  });

  it("intercepts nothing for a command that does not ask", async () => {
    const { cdp, driver } = await stack();
    await driver.execute(click());
    expect(sent(cdp, "Fetch.enable")).toEqual([]);
  });

  it("catches a callback that arrives between the click and the next read", async () => {
    const { cdp, driver } = await stack();
    const first = await driver.execute({
      ...click(CALLBACK),
      stopAtPersistent: true,
    });
    expect(first.stoppedAt).toBeUndefined();
    expect(sent(cdp, "Fetch.disable")).toHaveLength(0);
    cdp.emit("Fetch.requestPaused", paused(ANSWER));
    await flush();
    const result = await driver.execute({
      commandId: "read",
      source: "inspector",
      action: { kind: "observe", mode: "text" },
      stopAt: CALLBACK,
      stopAtPersistent: true,
    });
    expect(result.stoppedAt).toBe(ANSWER);
    expect(result.output).toBeUndefined();
    expect(sent(cdp, "Fetch.failRequest")).toHaveLength(1);
    expect(sent(cdp, "Fetch.disable")).toHaveLength(1);
  });

  it("answers with the stop when the stopped navigation rejects the page's own goto", async () => {
    const { page, cdp, driver } = await stack();
    page.goto = async () => {
      cdp.emit("Fetch.requestPaused", paused(ANSWER));
      await flush();
      throw new Error("net::ERR_FAILED");
    };
    const result = await driver.execute({
      commandId: "open",
      source: "inspector",
      action: { kind: "navigate", url: `${CONSENT}?again=1` },
      stopAt: CALLBACK,
      stopAtPersistent: true,
    });
    expect(result.stoppedAt).toBe(ANSWER);
    expect(sent(cdp, "Fetch.disable")).toHaveLength(1);
  });

  it("returns the URL to the caller and keeps it out of the ledger", async () => {
    const TOKEN = "per-boot-token-sample";
    const ledger = new CommandLedger({ bootId: "boot-1" });
    const handler = new BrowserdRequestHandler({
      queue: {
        submit: vi.fn(async () => ({
          status: "ok" as const,
          result: { ok: true, stoppedAt: ANSWER },
          bootId: "boot-1",
        })),
      },
      driver: { health: async () => ({ ok: true as const }) } as never,
      bootId: "boot-1",
      token: TOKEN,
      lease: new HandoffLease(),
      ledger,
    });
    const response = await handler.handle({
      method: "POST",
      path: "/v1/commands",
      origin: undefined,
      authorization: `Bearer ${TOKEN}`,
      body: JSON.stringify({ command: click(CALLBACK) }),
    });
    expect(
      (response.body as { result: { stoppedAt?: string } }).result.stoppedAt,
    ).toBe(ANSWER);
    const recorded = JSON.stringify(ledger.read({ limit: 10 }));
    expect(recorded).not.toContain(CODE);
    expect(recorded).not.toContain(STATE);
  });

  it("is announced, so a server checks before it relies on one", () => {
    expect(BROWSERD_WEBMCP_FEATURES).toContain("navigation-stop");
    expect(BROWSERD_WEBMCP_FEATURES).toContain("navigation-stop-persistent");
  });
});
