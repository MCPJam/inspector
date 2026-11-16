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

  it("intercepts nothing for a command that does not ask", async () => {
    const { cdp, driver } = await stack();
    await driver.execute(click());
    expect(sent(cdp, "Fetch.enable")).toEqual([]);
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
  });
});
