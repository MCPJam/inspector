import { describe, expect, it, vi } from "vitest";
import { BrowserdRequestHandler, type DaemonRequest } from "../request-handler";
import { HandoffLease } from "../lease";
import { shortHash } from "../state-token";
import { parsePaneCommand, paneCommandToAction } from "../pane-command";
import type { BrowserCommand, BrowserCommandOutcome } from "../../protocol";
import { INITIAL_SESSION_VIEWPORT } from "../../../../../shared/browser-viewport";

/**
 * The three endpoints a person's browser needs, and the rule that a person's
 * navigation takes the browser while an agent's is refused by it.
 */

const TOKEN = "s3cr3t-per-boot-token";
const BOOT = "boot-abc";

function makeHandler(
  over: {
    lease?: HandoffLease;
    authority?: "shared" | "lease";
    submit?: (c: BrowserCommand) => Promise<BrowserCommandOutcome>;
    stateSnapshot?: () => Promise<unknown>;
    requestViewport?: (size: {
      width: number;
      height: number;
    }) => Promise<unknown>;
    currentStateToken?: (tabId?: string) => Promise<unknown>;
  } = {},
) {
  const submitted: BrowserCommand[] = [];
  const submit =
    over.submit ??
    (async (): Promise<BrowserCommandOutcome> => ({
      status: "ok",
      result: { ok: true },
      bootId: BOOT,
    }));
  const lease = over.lease ?? new HandoffLease();
  const handler = new BrowserdRequestHandler({
    queue: {
      submit: (command) => {
        submitted.push(command);
        return submit(command);
      },
    },
    driver: {
      health: async () => ({ ok: true as const }),
      sessionViewportState: () => INITIAL_SESSION_VIEWPORT,
      ...(over.stateSnapshot
        ? { stateSnapshot: over.stateSnapshot as never }
        : {}),
      ...(over.requestViewport
        ? { requestViewport: over.requestViewport as never }
        : {}),
      ...(over.currentStateToken
        ? { currentStateToken: over.currentStateToken as never }
        : {}),
    },
    bootId: BOOT,
    token: TOKEN,
    authority: over.authority,
    lease,
  });
  return { handler, lease, submitted };
}

function req(over: Partial<DaemonRequest> = {}): DaemonRequest {
  return {
    method: "POST",
    path: "/v1/pane-command",
    origin: undefined,
    authorization: `Bearer ${TOKEN}`,
    body: "{}",
    ...over,
  };
}

const snapshot = () => ({
  seq: 7,
  tabs: [
    { id: "t1", url: "https://a.test/", title: "A", loading: false },
    { id: "t2", url: "https://b.test/", title: "B", loading: false },
  ],
  activeTabId: "t1",
  canGoBack: true,
  canGoForward: false,
  viewport: INITIAL_SESSION_VIEWPORT,
  policy: "fixed" as const,
});

describe("GET /v1/state", () => {
  it("answers with the whole browser, and who is driving", async () => {
    const { handler } = makeHandler({ stateSnapshot: async () => snapshot() });
    const res = await handler.handle(
      req({ method: "GET", path: "/v1/state", body: "" }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      seq: 7,
      activeTabId: "t1",
      canGoBack: true,
      control: { kind: "agent" },
    });
  });

  it("names the human holder, and marks a parked lease", async () => {
    const now = vi.fn(() => 1_000);
    const lease = new HandoffLease({ now, defaultTtlMs: 100 });
    lease.acquire("pane-1");
    const { handler } = makeHandler({
      lease,
      stateSnapshot: async () => snapshot(),
    });

    let res = await handler.handle(
      req({
        method: "GET",
        path: "/v1/state",
        body: "",
        query: new URLSearchParams({ holder: "pane-1" }),
      }),
    );
    expect(res.body).toMatchObject({
      control: { kind: "human", holder: "pane-1" },
    });

    now.mockReturnValue(5_000);
    res = await handler.handle(
      req({
        method: "GET",
        path: "/v1/state",
        body: "",
        query: new URLSearchParams({ holder: "pane-1" }),
      }),
    );
    expect(res.body).toMatchObject({ control: { parked: true } });
  });

  it("withholds the tab list from a pane that does not hold the browser", async () => {
    // "Reset your password | Acme" is not a screenshot, but it is not nothing.
    const lease = new HandoffLease();
    lease.acquire("someone-else");
    const { handler } = makeHandler({
      lease,
      stateSnapshot: async () => snapshot(),
    });
    const res = await handler.handle(
      req({
        method: "GET",
        path: "/v1/state",
        body: "",
        query: new URLSearchParams({ holder: "pane-1" }),
      }),
    );
    expect(res.status).toBe(423);
    expect(res.body).toMatchObject({ error: "lease_held" });
  });

  it("says so rather than drawing an empty strip when the engine cannot answer", async () => {
    const { handler } = makeHandler();
    const res = await handler.handle(
      req({ method: "GET", path: "/v1/state", body: "" }),
    );
    expect(res.status).toBe(501);
    expect(res.body).toMatchObject({ error: "state_unsupported" });
  });
});

describe("POST /v1/pane-command — automatic takeover", () => {
  it("takes the browser and dispatches, in that order", async () => {
    const { handler, lease, submitted } = makeHandler();
    const res = await handler.handle(
      req({
        body: JSON.stringify({
          holder: "pane-1",
          command: { op: "navigate", url: "example.com" },
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(lease.state()).toMatchObject({ state: "held", holder: "pane-1" });
    expect(submitted[0]).toMatchObject({
      source: "manual",
      action: { kind: "navigate", url: "https://example.com/" },
    });
  });

  it("refuses when somebody else has it, and says who", async () => {
    const lease = new HandoffLease();
    lease.acquire("pane-2");
    const { handler, submitted } = makeHandler({ lease });
    const res = await handler.handle(
      req({
        body: JSON.stringify({
          holder: "pane-1",
          command: { op: "reload" },
        }),
      }),
    );
    expect(res.status).toBe(423);
    expect(res.body).toMatchObject({
      error: "lease_held",
      holder: { kind: "human", id: "pane-2" },
    });
    // Nothing reached the page.
    expect(submitted).toHaveLength(0);
  });

  it("is idempotent for the holder, so a command is also a confirmation", async () => {
    const { handler, lease } = makeHandler();
    await handler.handle(
      req({
        body: JSON.stringify({ holder: "pane-1", command: { op: "reload" } }),
      }),
    );
    const res = await handler.handle(
      req({
        body: JSON.stringify({ holder: "pane-1", command: { op: "reload" } }),
      }),
    );
    expect(res.status).toBe(200);
    expect(lease.state()).toMatchObject({ holder: "pane-1" });
  });

  it("drops the command when the page moved during the acquire", async () => {
    // A coordinate decided from one screenshot aimed at a different one is the
    // failure `stale_observation` exists to prevent, and it does not stop
    // being that failure because a person decided the coordinate.
    const { handler, submitted } = makeHandler({
      currentStateToken: async () => ({
        tabId: "t1",
        navCounter: 9,
        urlHash: shortHash("https://moved.test/"),
        domHash: "d",
      }),
    });
    const res = await handler.handle(
      req({
        body: JSON.stringify({
          holder: "pane-1",
          command: { op: "reload", tabId: "t1" },
          anchor: { tabId: "t1", url: "https://a.test/", navCounter: 8 },
        }),
      }),
    );
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "page_changed" });
    expect(submitted).toHaveLength(0);
  });

  it("dispatches when the anchor still names the page it did", async () => {
    const { handler, submitted } = makeHandler({
      currentStateToken: async () => ({
        tabId: "t1",
        navCounter: 8,
        urlHash: shortHash("https://a.test/"),
        domHash: "d",
      }),
    });
    const res = await handler.handle(
      req({
        body: JSON.stringify({
          holder: "pane-1",
          command: { op: "reload", tabId: "t1" },
          anchor: { tabId: "t1", url: "https://a.test/", navCounter: 8 },
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(submitted).toHaveLength(1);
  });

  it("treats an unreadable page as a changed one", async () => {
    const { handler, submitted } = makeHandler({
      currentStateToken: async () => undefined,
    });
    const res = await handler.handle(
      req({
        body: JSON.stringify({
          holder: "pane-1",
          command: { op: "reload", tabId: "t1" },
          anchor: { tabId: "t1", url: "https://a.test/", navCounter: 8 },
        }),
      }),
    );
    expect(res.status).toBe(409);
    expect(submitted).toHaveLength(0);
  });

  it("does not treat a driver that cannot answer as a changed page", async () => {
    // `currentStateToken` is optional so that older drivers keep working.
    // Refusing every anchored command on a driver that simply lacks it made
    // clicking the page impossible there — the pane was told the page had
    // changed, forever, about a page sitting perfectly still.
    const { handler, submitted } = makeHandler(); // no currentStateToken
    const res = await handler.handle(
      req({
        body: JSON.stringify({
          holder: "pane-1",
          command: { op: "reload", tabId: "t1" },
          anchor: { tabId: "t1", url: "https://a.test/", navCounter: 8 },
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(submitted).toHaveLength(1);
  });

  it("refuses a command with no holder", async () => {
    const { handler } = makeHandler();
    const res = await handler.handle(
      req({ body: JSON.stringify({ command: { op: "reload" } }) }),
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "holder_required" });
  });

  it("refuses a url a person has no business being sent to", async () => {
    const { handler, lease } = makeHandler();
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "nonsense",
    ]) {
      const res = await handler.handle(
        req({
          body: JSON.stringify({
            holder: "pane-1",
            command: { op: "navigate", url },
          }),
        }),
      );
      expect(res.status).toBe(400);
    }
    // And the refusal happens before the lease is touched.
    expect(lease.state()).toMatchObject({ state: "free" });
  });
});

describe("POST /v1/viewport", () => {
  it("answers with the size the session ended at", async () => {
    const { handler } = makeHandler({
      requestViewport: async () => ({
        width: 1400,
        height: 900,
        revision: 3,
      }),
    });
    const res = await handler.handle(
      req({
        path: "/v1/viewport",
        body: JSON.stringify({ width: 1400, height: 900 }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      viewport: { width: 1400, height: 900, revision: 3 },
    });
  });

  it("refuses a measurement that is not two numbers", async () => {
    const { handler } = makeHandler({
      requestViewport: async () => INITIAL_SESSION_VIEWPORT,
    });
    const res = await handler.handle(
      req({ path: "/v1/viewport", body: JSON.stringify({ width: "wide" }) }),
    );
    expect(res.status).toBe(400);
  });

  it("says so when the engine cannot resize", async () => {
    const { handler } = makeHandler();
    const res = await handler.handle(
      req({
        path: "/v1/viewport",
        body: JSON.stringify({ width: 1400, height: 900 }),
      }),
    );
    expect(res.status).toBe(501);
    expect(res.body).toMatchObject({ error: "viewport_unsupported" });
  });
});

describe("parsePaneCommand", () => {
  it("normalises what a person typed", () => {
    expect(
      parsePaneCommand({ op: "navigate", url: "  example.com  " }),
    ).toEqual({ op: "navigate", url: "https://example.com/" });
  });

  it("refuses an op that is not a person's to send", () => {
    // `observe`, `invoke_page_tool`: an agent's vocabulary, not a pane's.
    expect(parsePaneCommand({ op: "observe", mode: "url" })).toBeNull();
    expect(parsePaneCommand({ op: "act", verb: "click" })).toBeNull();
  });

  it("requires a tab for the tab-addressed ops", () => {
    expect(parsePaneCommand({ op: "close_tab" })).toBeNull();
    expect(parsePaneCommand({ op: "activate_tab", tabId: "t1" })).toEqual({
      op: "activate_tab",
      tabId: "t1",
    });
  });

  it("allows a new tab with no url at all", () => {
    expect(parsePaneCommand({ op: "create_tab" })).toEqual({
      op: "create_tab",
    });
  });
});

describe("paneCommandToAction", () => {
  it("mints a fresh tab id for create_tab", () => {
    // The driver refuses `newTab` onto an id that already exists, and a pane
    // choosing its own ids would discover the collision as an error a person
    // cannot act on.
    const first = paneCommandToAction({ op: "create_tab" });
    const second = paneCommandToAction({ op: "create_tab" });
    expect(first.tabId).toBeTruthy();
    expect(first.tabId).not.toBe(second.tabId);
    expect(first.action).toMatchObject({ kind: "navigate", newTab: true });
  });

  it("opens a new tab at a blank page rather than a page of ours", () => {
    // A start page served from the inspector would be a document with this
    // app's origin inside the agent's browser.
    expect(paneCommandToAction({ op: "create_tab" }).action).toMatchObject({
      url: "about:blank",
    });
  });

  it("maps every navigation op onto its driver verb", () => {
    expect(paneCommandToAction({ op: "back" }).action).toMatchObject({
      kind: "back",
    });
    expect(paneCommandToAction({ op: "forward" }).action).toMatchObject({
      kind: "forward",
    });
    expect(paneCommandToAction({ op: "reload" }).action).toMatchObject({
      kind: "reload",
    });
  });

  it("asks for no observation, because the pane is watching the picture", () => {
    // A person driving already sees the page; folding an a11y tree and a
    // screenshot into every click would be a round trip per keystroke.
    for (const command of [
      { op: "back" },
      { op: "forward" },
      { op: "reload" },
      { op: "navigate", url: "https://a.test/" },
    ] as const) {
      expect(paneCommandToAction(command).action).toMatchObject({
        observe: "none",
      });
    }
  });
});

describe("shared inspection authority", () => {
  it("runs navigation without acquiring a synthetic lease", async () => {
    const { handler, lease, submitted } = makeHandler({ authority: "shared" });
    const res = await handler.handle(
      req({
        path: "/v1/pane-command",
        body: JSON.stringify({
          holder: "inspector",
          command: { op: "navigate", url: "https://a.test" },
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(submitted).toHaveLength(1);
    expect(lease.state().state).toBe("free");
  });
  it("does not allow a request to turn shared inspection into an exclusive lease", async () => {
    const { handler, lease } = makeHandler({ authority: "shared" });
    const res = await handler.handle(
      req({
        path: "/v1/lease",
        body: JSON.stringify({ action: "acquire", holder: "inspector" }),
      }),
    );
    expect(res.status).toBe(409);
    expect(lease.state().state).toBe("free");
  });
});
