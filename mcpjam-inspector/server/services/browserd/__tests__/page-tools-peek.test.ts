/**
 * The turn-start peek: what it reads, and — more importantly — what it refuses
 * to touch.
 *
 * Every "never" in this suite is a real bug it would otherwise be. Reading a
 * tool list must not launch a browser, wake a paused box, reserve a computer,
 * or drive somebody's browser under their own lease. And no failure here may
 * fail a conversation: the peek runs on the critical path of every
 * browser-capable turn, and most of those turns have no browser at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSERD_PROTOCOL_VERSION } from "../protocol.js";

const convexGetDesktopComputerStatus = vi.fn();
const lookupBrowserSession = vi.fn();
const findLocalBrowserSessionForProject = vi.fn();
const findLocalBrowserSessionForSession = vi.fn();
const getConversationSession = vi.fn();
const ensureBrowserSession = vi.fn();
const attachBrowserSession = vi.fn();
const clientStatus = vi.fn();
const clientSendCommand = vi.fn();

vi.mock("../../../utils/computers/convex-environment-client.js", () => ({
  convexGetDesktopComputerStatus: (...args: unknown[]) =>
    convexGetDesktopComputerStatus(...args),
}));
vi.mock("../browser-sessions-client.js", () => ({
  lookupBrowserSession: (...args: unknown[]) => lookupBrowserSession(...args),
}));
vi.mock("../local/local-browser-session.js", () => ({
  findLocalBrowserSessionForSession: (...args: unknown[]) =>
    findLocalBrowserSessionForSession(...args),
  findLocalBrowserSessionForProject: (...args: unknown[]) =>
    findLocalBrowserSessionForProject(...args),
  ensureLocalBrowserSession: () => {
    throw new Error("the peek must never START a local browser");
  },
}));
vi.mock("../session-service.js", () => ({
  BrowserSessionService: class {
    getConversationSession = getConversationSession;
  },
}));
vi.mock("../browserd-client.js", () => ({
  BrowserdClient: class {
    status = clientStatus;
    sendCommand = clientSendCommand;
  },
}));
vi.mock("../live-session-deps.js", () => ({
  browserdBundleHash: () => "hash-1",
  ensureBrowserSession: (...args: unknown[]) => ensureBrowserSession(...args),
  attachBrowserSession: (...args: unknown[]) => attachBrowserSession(...args),
}));
vi.mock("../../../utils/logger.js", () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { peekPageTools, peekPageToolsForChatTurn, pageToolsSnapshotFrom } =
  await import("../page-tools-peek");

const TOOL = {
  name: "add_topping",
  description: "Add a topping",
  origin: "https://pizza.test",
  isMainFrame: true,
  frameId: "frame-main",
  registrationSeq: 3,
};

function okObservation() {
  return {
    status: "ok" as const,
    bootId: "boot-1",
    result: {
      ok: true,
      output: {
        url: "https://pizza.test/",
        webmcpSupported: true,
        tools: [TOOL],
      },
      stateToken: {
        tabId: "@session",
        navCounter: 7,
        urlHash: "u",
        domHash: "d",
      },
      webmcpTools: {
        revision: 4,
        hash: "abc",
        count: 1,
        supported: true,
        url: "https://pizza.test/",
      },
    },
  };
}

function liveHostedSession() {
  convexGetDesktopComputerStatus.mockResolvedValue({
    computerId: "computer-1",
    status: "ready",
  });
  lookupBrowserSession.mockResolvedValue({
    session: {
      sessionId: "sess-1",
      bootId: "boot-1",
      publicOrigin: "https://box.test",
      browserdToken: "tok",
      contextMode: "persistent",
    },
  });
  clientStatus.mockResolvedValue({ kind: "ok", bootId: "boot-1" });
}

beforeEach(() => {
  vi.clearAllMocks();
  findLocalBrowserSessionForSession.mockReset();
  getConversationSession.mockReset().mockResolvedValue(null);
  clientSendCommand.mockResolvedValue(okObservation());
});

describe("conversation discovery across turns", () => {
  const turn = {
    builtInToolIds: ["browser"],
    browserToolId: "browser",
    firstClass: true,
    isHarnessTurn: false,
    hasV1PageTools: false,
    projectId: "p1",
  };

  it("rediscovers each local client's own tools on every turn without a warm-up command", async () => {
    findLocalBrowserSessionForSession.mockImplementation((_project, id) => ({
      handle: { bootId: `boot-${id}` },
      client: {
        sendCommand: vi.fn(async () => ({
          ...okObservation(),
          result: {
            ...okObservation().result,
            output: {
              ...okObservation().result.output,
              tools: [
                {
                  ...TOOL,
                  name: `add_${id}`,
                  registrationSeq: id === "cursor" ? 3 : 9,
                },
              ],
            },
          },
        })),
      },
    }));
    for (const id of ["cursor", "mcpjam", "mcpjam", "cursor"]) {
      const peek = await peekPageToolsForChatTurn({
        ...turn,
        engine: "local",
        conversationId: id,
      });
      expect(peek?.tools.map((tool) => tool.name)).toEqual([`add_${id}`]);
      expect(pageToolsSnapshotFrom(peek)?.bootId).toBe(`boot-${id}`);
    }
    expect(findLocalBrowserSessionForProject).not.toHaveBeenCalled();
    expect(
      findLocalBrowserSessionForSession.mock.calls.map((call) => call[1]),
    ).toEqual(["cursor", "mcpjam", "mcpjam", "cursor"]);
  });

  it("never borrows the project browser when a conversation is absent", async () => {
    findLocalBrowserSessionForProject.mockReturnValue({
      handle: { bootId: "unrelated" },
      client: { sendCommand: clientSendCommand },
    });
    const result = await peekPageToolsForChatTurn({
      ...turn,
      engine: "local",
      conversationId: "missing",
    });
    expect(result).toEqual({ tools: [], reason: "no_browser_session" });
    expect(findLocalBrowserSessionForProject).not.toHaveBeenCalled();
    expect(clientSendCommand).not.toHaveBeenCalled();
  });

  it("resolves hosted ownership before looking up the daemon, ignoring a different supplied sandbox", async () => {
    getConversationSession.mockImplementation(async ({ conversationId }) => ({
      sessionId: `logical-${conversationId}`,
      engine: "hosted",
      state: "active",
      box: { sandboxRowId: `box-${conversationId}` },
    }));
    lookupBrowserSession.mockImplementation(async ({ sandboxRowId }) => ({
      session: {
        bootId: "boot-1",
        logicalSessionId: `logical-${sandboxRowId.slice(4)}`,
        publicOrigin: "https://box.test",
        browserdToken: "tok",
      },
    }));
    clientStatus.mockResolvedValue({
      kind: "ok",
      bootId: "boot-1",
      features: ["webmcp-binding"],
    });
    for (const id of ["cursor", "mcpjam", "cursor"]) {
      expect(
        (
          await peekPageToolsForChatTurn({
            ...turn,
            engine: "hosted",
            bearer: "user",
            conversationId: id,
            sandboxRowId: "wrong-box",
          })
        )?.tools,
      ).toHaveLength(1);
      expect(lookupBrowserSession).toHaveBeenLastCalledWith(
        expect.objectContaining({ sandboxRowId: `box-${id}`, watched: true }),
      );
      expect(getConversationSession).toHaveBeenLastCalledWith(
        expect.objectContaining({
          projectId: "p1",
          conversationId: id,
          bearer: "user",
        }),
      );
    }
    expect(convexGetDesktopComputerStatus).not.toHaveBeenCalled();
    expect(ensureBrowserSession).not.toHaveBeenCalled();
    expect(attachBrowserSession).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { state: "sleeping" },
    { state: "closed" },
    { state: "active", engine: "local", box: { localKey: "local" } },
  ])(
    "does not fall back or wake an unavailable hosted owner: %j",
    async (owner) => {
      getConversationSession.mockResolvedValue(owner);
      expect(
        await peekPageTools({
          engine: "hosted",
          projectId: "p1",
          bearer: "user",
          conversationId: "cursor",
          sandboxRowId: "other",
        }),
      ).toEqual({ tools: [], reason: "no_browser_session" });
      expect(lookupBrowserSession).not.toHaveBeenCalled();
      expect(clientSendCommand).not.toHaveBeenCalled();
    },
  );

  it("refuses a sandbox rebound to a different conversation", async () => {
    getConversationSession.mockResolvedValue({
      sessionId: "logical-cursor",
      engine: "hosted",
      state: "active",
      box: { sandboxRowId: "box" },
    });
    lookupBrowserSession.mockResolvedValue({
      session: { logicalSessionId: "logical-other" },
    });
    expect(
      await peekPageTools({
        engine: "hosted",
        projectId: "p1",
        bearer: "user",
        conversationId: "cursor",
      }),
    ).toEqual({ tools: [], reason: "no_browser_session" });
    expect(clientStatus).not.toHaveBeenCalled();
  });
});

describe("peekPageTools — hosted", () => {
  it("reads the page's tools and the generation they belong to", async () => {
    liveHostedSession();
    const peek = await peekPageTools({
      engine: "hosted",
      projectId: "p1",
      bearer: "Bearer t",
    });
    expect(peek.tools.map((tool) => tool.name)).toEqual(["add_topping"]);
    // Identity survives the trip: without `frameId` and `registrationSeq` a
    // binding could not name WHICH registration on WHICH document.
    expect(peek.tools[0]).toMatchObject({
      frameId: "frame-main",
      registrationSeq: 3,
    });
    expect(peek.binding).toEqual({
      bootId: "boot-1",
      tabId: "@session",
      navCounter: 7,
    });
    expect(peek.revision).toMatchObject({ revision: 4, hash: "abc" });
    expect(peek.reason).toBeUndefined();
  });

  it("NEVER starts, attaches or reserves a browser", async () => {
    liveHostedSession();
    await peekPageTools({ engine: "hosted", projectId: "p1", bearer: "t" });
    // Each of these bills a cloud desktop or opens a window on somebody's
    // machine. Asking what a page offers must not do either.
    expect(ensureBrowserSession).not.toHaveBeenCalled();
    expect(attachBrowserSession).not.toHaveBeenCalled();
  });

  it("stops at a computer that is not ready", async () => {
    convexGetDesktopComputerStatus.mockResolvedValue({
      computerId: "computer-1",
      status: "paused",
    });
    const peek = await peekPageTools({
      engine: "hosted",
      projectId: "p1",
      bearer: "t",
    });
    expect(peek).toEqual({ tools: [], reason: "no_browser_session" });
    // A paused box is one nobody is using. Looking harder means waking it.
    expect(lookupBrowserSession).not.toHaveBeenCalled();
  });

  it("answers none when the project has no computer at all", async () => {
    convexGetDesktopComputerStatus.mockResolvedValue(null);
    const peek = await peekPageTools({
      engine: "hosted",
      projectId: "p1",
      bearer: "t",
    });
    expect(peek.reason).toBe("no_browser_session");
    expect(lookupBrowserSession).not.toHaveBeenCalled();
  });

  it("refuses a session row whose daemon has since restarted", async () => {
    liveHostedSession();
    clientStatus.mockResolvedValue({ kind: "ok", bootId: "boot-2" });
    const peek = await peekPageTools({
      engine: "hosted",
      projectId: "p1",
      bearer: "t",
    });
    expect(peek.reason).toBe("no_browser_session");
    expect(clientSendCommand).not.toHaveBeenCalled();
  });

  it("looks up a per-run box directly, not the project computer", async () => {
    lookupBrowserSession.mockResolvedValue({
      session: {
        bootId: "boot-1",
        publicOrigin: "https://sbx.test",
        browserdToken: "tok",
      },
    });
    clientStatus.mockResolvedValue({ kind: "ok", bootId: "boot-1" });
    await peekPageTools({
      engine: "hosted",
      projectId: "p1",
      bearer: "t",
      sandboxRowId: "row-1",
    });
    // Asking about the project computer would answer for a different browser
    // entirely.
    expect(convexGetDesktopComputerStatus).not.toHaveBeenCalled();
    expect(lookupBrowserSession).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxRowId: "row-1" }),
    );
  });

  it("names the protocol version on BOTH lookups, not just the sandbox one", async () => {
    // Omitted, the backend answers `bundle_changed` for a live session whose
    // wire this build can still talk to — so a deploy that only rotated the
    // bundle hash reads as "no browser", and the turn advertises no page tools
    // at all. The project-computer path is the hosted Playground, which is the
    // one that mattered most and the one that was missing it.
    liveHostedSession();
    await peekPageTools({ engine: "hosted", projectId: "p1", bearer: "t" });
    expect(lookupBrowserSession).toHaveBeenCalledWith(
      expect.objectContaining({
        computerId: expect.anything(),
        expectedProtocolVersion: BROWSERD_PROTOCOL_VERSION,
      }),
    );
  });
});

describe("peekPageTools — the lease", () => {
  it("reports lease_held and does NOT retry as the holder's manual command", async () => {
    liveHostedSession();
    clientSendCommand.mockResolvedValue({
      status: "lease_blocked",
      lease: "held",
      holder: "users_1",
      bootId: "boot-1",
    });
    const peek = await peekPageTools({
      engine: "hosted",
      projectId: "p1",
      bearer: "t",
    });
    expect(peek).toEqual({
      tools: [],
      reason: "lease_held",
      // The daemon is there and answered, so the refresher gets a boot to
      // start from once the person hands back.
      binding: { bootId: "boot-1", tabId: "@session", navCounter: 0 },
      canBind: false,
    });
    // The panel routes DO retry as `manual`, and are right to: a person
    // looking at their own page is what a lease is for. A chat turn is not
    // that person, and re-sending the model's read under their lease would
    // drive their browser while their hands are on it.
    expect(clientSendCommand).toHaveBeenCalledTimes(1);
    expect(clientSendCommand.mock.calls[0][0].source).toBe("chat");
    expect(clientSendCommand.mock.calls[0][0].holder).toBeUndefined();
  });
});

describe("peekPageTools — fail-empty", () => {
  it("names 'no page yet' rather than reporting a failure", async () => {
    liveHostedSession();
    clientSendCommand.mockResolvedValue({
      status: "ok",
      bootId: "boot-1",
      result: { ok: false, error: "unknown_tab: @session" },
    });
    // The ORDINARY state between a session starting and the first navigation:
    // the driver refuses to conjure an about:blank tab to observe.
    const peek = await peekPageTools({
      engine: "hosted",
      projectId: "p1",
      bearer: "t",
    });
    // WITH A BINDING. This is the start of the turn the feature exists for —
    // navigate on step one, call the page's tools on step two — and the
    // binding is what lets the refresher be built. `navCounter: 0` says no
    // document has loaded yet, which is true.
    expect(peek).toEqual({
      tools: [],
      reason: "no_page",
      binding: { bootId: "boot-1", tabId: "@session", navCounter: 0 },
      canBind: false,
    });
  });

  it("carries the daemon's binding capability on a 'no page yet' answer too", async () => {
    liveHostedSession();
    clientStatus.mockResolvedValue({
      kind: "ok",
      bootId: "boot-1",
      features: ["webmcp-eager", "webmcp-binding"],
    });
    clientSendCommand.mockResolvedValue({
      status: "ok",
      bootId: "boot-1",
      result: { ok: false, error: "unknown_tab: @session" },
    });
    const peek = await peekPageTools({
      engine: "hosted",
      projectId: "p1",
      bearer: "t",
    });
    expect(peek.canBind).toBe(true);
    // And the snapshot the builder takes exists, so the refresher can be built.
    expect(pageToolsSnapshotFrom(peek)).toMatchObject({
      tools: [],
      bootId: "boot-1",
      navCounter: 0,
      canBind: true,
    });
  });

  it("keeps a binding when a person holds the browser", async () => {
    // The daemon is there and answered; the turn — a person signing in, then
    // handing back — is one where the page's tools become reachable mid-turn,
    // and the refresher needs a boot to start from.
    liveHostedSession();
    clientSendCommand.mockResolvedValue({
      status: "lease_blocked",
      bootId: "boot-1",
    });
    const peek = await peekPageTools({
      engine: "hosted",
      projectId: "p1",
      bearer: "t",
    });
    expect(peek.reason).toBe("lease_held");
    expect(peek.binding).toEqual({
      bootId: "boot-1",
      tabId: "@session",
      navCounter: 0,
    });
  });

  it("swallows a thrown lookup", async () => {
    convexGetDesktopComputerStatus.mockRejectedValue(new Error("convex down"));
    await expect(
      peekPageTools({ engine: "hosted", projectId: "p1", bearer: "t" }),
    ).resolves.toEqual({ tools: [], reason: "no_browser_session" });
  });

  it("gives up on its own deadline rather than holding up the turn", async () => {
    liveHostedSession();
    clientSendCommand.mockImplementation(
      () => new Promise(() => {}) as Promise<never>,
    );
    const peek = await peekPageTools({
      engine: "hosted",
      projectId: "p1",
      bearer: "t",
      deadlineMs: 20,
    });
    expect(peek).toEqual({ tools: [], reason: "timeout" });
  });

  it("reports a busy daemon as busy, not as a broken one", async () => {
    liveHostedSession();
    clientSendCommand.mockResolvedValue({ status: "busy", bootId: "boot-1" });
    const peek = await peekPageTools({
      engine: "hosted",
      projectId: "p1",
      bearer: "t",
    });
    expect(peek.reason).toBe("busy");
  });
});

describe("peekPageTools — local", () => {
  it("reads a running local browser and never starts one", async () => {
    findLocalBrowserSessionForProject.mockReturnValue({
      client: { sendCommand: clientSendCommand },
      handle: { bootId: "boot-local" },
    });
    const peek = await peekPageTools({ engine: "local", projectId: "p1" });
    expect(peek.tools).toHaveLength(1);
    expect(peek.binding?.bootId).toBe("boot-local");
  });

  it("answers none when nothing is running on this machine", async () => {
    findLocalBrowserSessionForProject.mockReturnValue(undefined);
    const peek = await peekPageTools({ engine: "local", projectId: "p1" });
    expect(peek).toEqual({ tools: [], reason: "no_browser_session" });
  });
});

describe("peekPageToolsForChatTurn — the gate", () => {
  const base = {
    builtInToolIds: ["browser"],
    browserToolId: "browser",
    firstClass: true,
    isHarnessTurn: false,
    hasV1PageTools: false,
    engine: "hosted" as const,
    projectId: "p1",
    bearer: "t",
  };

  beforeEach(() => liveHostedSession());

  it("reads when everything lines up", async () => {
    await expect(peekPageToolsForChatTurn(base)).resolves.toMatchObject({
      tools: [expect.objectContaining({ name: "add_topping" })],
    });
  });

  it("does not read with the flag off", async () => {
    await expect(
      peekPageToolsForChatTurn({ ...base, firstClass: false }),
    ).resolves.toBeUndefined();
    expect(clientSendCommand).not.toHaveBeenCalled();
  });

  it("does not read for a turn with no browser capability", async () => {
    await expect(
      peekPageToolsForChatTurn({ ...base, builtInToolIds: ["bash"] }),
    ).resolves.toBeUndefined();
    // A turn that was never going to drive a browser must not pay a daemon
    // round trip to discover that.
    expect(convexGetDesktopComputerStatus).not.toHaveBeenCalled();
  });

  it("does not read for a harness turn", async () => {
    // A harness takes its toolset as a constructor argument and cannot grow
    // it, so a set read at turn start is one it could never update.
    await expect(
      peekPageToolsForChatTurn({ ...base, isHarnessTurn: true }),
    ).resolves.toBeUndefined();
  });

  it("does not read when the client is already fulfilling page tools itself", async () => {
    // Advertising one page's tools twice, under two namespaces with two
    // fulfilment paths, is how a model calls one of each and a person sees two
    // different answers.
    await expect(
      peekPageToolsForChatTurn({ ...base, hasV1PageTools: true }),
    ).resolves.toBeUndefined();
  });
});

describe("pageToolsSnapshotFrom", () => {
  it("carries the tools and their generation together", async () => {
    liveHostedSession();
    const peek = await peekPageTools({
      engine: "hosted",
      projectId: "p1",
      bearer: "t",
    });
    expect(pageToolsSnapshotFrom(peek)).toMatchObject({
      bootId: "boot-1",
      tabId: "@session",
      navCounter: 7,
      revision: 4,
      hash: "abc",
    });
  });

  it("is undefined when there is nothing to build from", () => {
    expect(pageToolsSnapshotFrom(undefined)).toBeUndefined();
    // NO BINDING is the only "nothing". Without one there is no generation to
    // bind an invocation to, so there is nothing a tool could be built against.
    expect(
      pageToolsSnapshotFrom({ tools: [], reason: "no_browser_session" }),
    ).toBeUndefined();
  });

  it("reports whether the daemon can BIND, not just whether it answered", () => {
    // Two different daemons answer this read identically. Only one of them
    // enforces `expectedBinding`, and on the other the binding is decorative —
    // the call is still resolved by name at the far end. The turn has to be
    // able to tell them apart, because a typed tool over an unenforced binding
    // is the generic verb wearing a better schema.
    expect(
      pageToolsSnapshotFrom({
        tools: [],
        canBind: false,
        binding: { bootId: "b", tabId: "@session", navCounter: 1 },
      })?.canBind,
    ).toBe(false);
    expect(
      pageToolsSnapshotFrom({
        tools: [],
        canBind: true,
        binding: { bootId: "b", tabId: "@session", navCounter: 1 },
      })?.canBind,
    ).toBe(true);
  });

  it("KEEPS a binding for a live page that declares no tools", () => {
    // "This page declares nothing" and "we could not look" are different facts,
    // and only the second is a reason to build nothing. A turn that opens on a
    // blank tab and navigates to a page full of tools is the ordinary case this
    // whole feature is for — dropping the binding here would take away the
    // generation the refresher needs and leave that turn unable to grow a
    // single tool.
    const snapshot = pageToolsSnapshotFrom({
      tools: [],
      binding: { bootId: "b", tabId: "@session", navCounter: 1 },
    });
    expect(snapshot).toMatchObject({
      bootId: "b",
      tabId: "@session",
      navCounter: 1,
    });
    // And it still advertises nothing to begin with, which is the other half.
    expect(snapshot?.tools).toEqual([]);
  });
});

describe("peekPageTools — a browser this build cannot talk to", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConversationSession.mockResolvedValue({
      sessionId: "logical-1",
      engine: "hosted",
      state: "active",
      box: { sandboxRowId: "box-1" },
    });
  });

  it("says the wire changed rather than 'no browser session'", async () => {
    // The lookup sends `expectedProtocolVersion`, so a daemon speaking a wire
    // this build cannot talk to comes back as a STALE ROW. Reporting that as
    // "no browser session" is a lie a person acts on: told there is no
    // browser, they open one — and the box already has one, running, holding
    // their logins.
    lookupBrowserSession.mockResolvedValue({
      session: null,
      stale: "protocol_changed",
    });
    expect(
      await peekPageTools({
        engine: "hosted",
        projectId: "p1",
        bearer: "user",
        conversationId: "c1",
      }),
    ).toEqual({ tools: [], reason: "protocol_mismatch" });
    expect(clientSendCommand).not.toHaveBeenCalled();
  });

  it("still says 'no browser session' when the row is simply absent", async () => {
    lookupBrowserSession.mockResolvedValue({ session: null });
    expect(
      await peekPageTools({
        engine: "hosted",
        projectId: "p1",
        bearer: "user",
        conversationId: "c1",
      }),
    ).toEqual({ tools: [], reason: "no_browser_session" });
  });

  it("names the wire when the DAEMON disagrees, even though the row did not", async () => {
    // The row is the control plane's opinion, written when the daemon was last
    // recorded. The daemon itself is the authority, and it can have been
    // replaced since.
    lookupBrowserSession.mockResolvedValue({
      session: {
        bootId: "boot-1",
        logicalSessionId: "logical-1",
        publicOrigin: "https://box.test",
        browserdToken: "tok",
      },
    });
    clientStatus.mockResolvedValue({
      kind: "ok",
      bootId: "boot-1",
      protocolVersion: BROWSERD_PROTOCOL_VERSION + 1,
      features: ["webmcp-binding"],
    });
    expect(
      await peekPageTools({
        engine: "hosted",
        projectId: "p1",
        bearer: "user",
        conversationId: "c1",
        sandboxRowId: "box-1",
      }),
    ).toEqual({ tools: [], reason: "protocol_mismatch" });
    expect(clientSendCommand).not.toHaveBeenCalled();
  });

  it("reads the tools from a daemon too old to announce a version at all", async () => {
    // Absence is not a mismatch. Every daemon predating the field answers
    // nothing here, and refusing them would take page tools away from boxes
    // that work.
    lookupBrowserSession.mockResolvedValue({
      session: {
        bootId: "boot-1",
        logicalSessionId: "logical-1",
        publicOrigin: "https://box.test",
        browserdToken: "tok",
      },
    });
    clientStatus.mockResolvedValue({ kind: "ok", bootId: "boot-1" });
    clientSendCommand.mockResolvedValue(okObservation());
    const peek = await peekPageTools({
      engine: "hosted",
      projectId: "p1",
      bearer: "user",
      conversationId: "c1",
      sandboxRowId: "box-1",
    });
    expect(peek.reason).toBeUndefined();
    expect(clientSendCommand).toHaveBeenCalled();
  });
});
