import { describe, expect, it } from "vitest";
import {
  decodeStateToken,
  encodeStateToken,
  executedResult,
  publishedOpFor,
  refusedResult,
  toAgentPage,
  toDaemonAction,
  unknownResult,
} from "../agent-contract-mapper";
import { BROWSER_AGENT_VIEWPORT } from "../../../../shared/browser-agent-contract";
import {
  BROWSERD_OBSERVATION_VIEWPORT,
  type BrowserAction,
  type ObservationStateToken,
} from "../protocol";

const TOKEN: ObservationStateToken = {
  tabId: "t1",
  navCounter: 3,
  urlHash: "abc",
  domHash: "def",
};

describe("the published viewport is the daemon's viewport", () => {
  it("agrees, because a second copy of a coordinate space mis-aims every click", () => {
    // The module asserts this at load; this test says why it matters and fails
    // loudly if someone changes one constant and not the other.
    expect(BROWSER_AGENT_VIEWPORT.width).toBe(BROWSERD_OBSERVATION_VIEWPORT.width);
    expect(BROWSER_AGENT_VIEWPORT.height).toBe(
      BROWSERD_OBSERVATION_VIEWPORT.height,
    );
  });
});

describe("toDaemonAction", () => {
  it("defaults an acting verb to folding in an a11y tree", () => {
    // One round trip instead of two: the caller's next act is usually by ref,
    // and a screenshot carries no refs.
    for (const command of [
      { op: "act", verb: "click" },
      { op: "navigate", url: "https://x.test" },
      { op: "back" },
      { op: "reload" },
    ] as const) {
      const mapped = toDaemonAction(command);
      expect(mapped.ok && "observe" in mapped.action && mapped.action.observe).toBe(
        "a11y",
      );
    }
  });

  it("maps the contract's observeAfter onto the daemon's observe", () => {
    // The two names are deliberate, not an oversight: the contract is versioned
    // for agents and the daemon's unions move with each engine wave, so the
    // mapper is the one place they meet. `main` landing `ActObserve` while this
    // branch carried `BrowserObserveAfter` is exactly the drift that seam is
    // for — the daemon converged, the published name did not have to.
    const mapped = toDaemonAction({
      op: "act",
      verb: "click",
      observeAfter: "none",
    });
    expect(mapped.ok && "observe" in mapped.action && mapped.action.observe).toBe(
      "none",
    );
  });

  it("maps a ref target through to the daemon rather than second-guessing it", () => {
    // Refusing here would be this layer deciding a question it cannot see: a
    // ref is scoped to the tab that issued it and checked against that
    // observation's state token, and only the daemon holds either.
    const mapped = toDaemonAction({
      op: "act",
      verb: "click",
      target: { ref: "e7" },
    });
    expect(mapped.ok).toBe(true);
    expect(mapped.ok && mapped.action).toMatchObject({
      kind: "act",
      verb: "click",
      target: { a11yRef: "e7" },
    });
  });

  it("REFUSES an out-of-viewport coordinate rather than clamping it", () => {
    // Chromium delivers a mouse event outside the viewport happily; it lands on
    // nothing and the caller gets an ordinary "here is the page after your
    // action" — a no-op indistinguishable from a click on a dead area.
    const mapped = toDaemonAction({
      op: "act",
      verb: "click",
      target: { coordinates: [2000, 10] },
    });
    expect(mapped.ok).toBe(false);
    expect(!mapped.ok && mapped.refusal.message).toContain("outside the observation");
    // The refusal names the space, so a caller can fix its arithmetic.
    expect(!mapped.ok && mapped.refusal.message).toContain("1024x768");
  });

  it("accepts the last pixel inside the viewport", () => {
    const mapped = toDaemonAction({
      op: "act",
      verb: "click",
      target: { coordinates: [1023, 767] },
    });
    expect(mapped.ok).toBe(true);
  });

  it("maps `page_tools` onto the daemon's protocol-named mode", () => {
    // A caller should not have to know which standard a page implements to ask
    // what tools it offers.
    const mapped = toDaemonAction({ op: "observe", mode: "page_tools" });
    expect(mapped.ok && mapped.action).toMatchObject({
      kind: "observe",
      mode: "webmcp_tools",
    });
  });

  it("passes every other observe mode through unchanged", () => {
    for (const mode of ["a11y", "screenshot", "text", "dom", "console", "url"] as const) {
      const mapped = toDaemonAction({ op: "observe", mode });
      expect(mapped.ok && mapped.action).toMatchObject({ kind: "observe", mode });
    }
  });

  it("round-trips an opaque state token onto the daemon's structured one", () => {
    const mapped = toDaemonAction({
      op: "act",
      verb: "click",
      expectedState: encodeStateToken(TOKEN),
    });
    expect(mapped.ok && mapped.action).toMatchObject({ expectedState: TOKEN });
  });

  it("treats an unreadable state token as absent rather than failing the act", () => {
    // The documented consequence of omitting a token is losing staleness
    // protection for one act — not losing the act.
    expect(decodeStateToken("not-a-token")).toBeUndefined();
    expect(decodeStateToken(Buffer.from('{"tabId":1}').toString("base64url"))).toBeUndefined();
    const mapped = toDaemonAction({
      op: "act",
      verb: "click",
      expectedState: "garbage",
    });
    expect(mapped.ok).toBe(true);
    expect(mapped.ok && "expectedState" in mapped.action).toBe(false);
  });
});

describe("publishedOpFor — the reverse exhaustive check", () => {
  it("names a published op for every daemon action kind", () => {
    // The real guard is the `never` arm in the mapper: adding a verb to
    // `BrowserAction` stops this file compiling until someone decides whether
    // the agent surface offers it. This asserts the decisions already taken.
    const cases: Array<[BrowserAction, string]> = [
      [{ kind: "navigate", url: "https://x.test" }, "navigate"],
      [{ kind: "back" }, "back"],
      [{ kind: "reload" }, "reload"],
      [{ kind: "act", verb: "click" }, "act"],
      [{ kind: "observe", mode: "url" }, "observe"],
      [{ kind: "webmcp_invoke", toolKey: "pay", input: {} }, "invoke_page_tool"],
      [{ kind: "webmcp_cancel", invocationId: "i1" }, "cancel_page_tool"],
    ];
    for (const [action, op] of cases) expect(publishedOpFor(action)).toBe(op);
  });

  it("throws rather than guessing for an action it was never taught", () => {
    expect(() =>
      publishedOpFor({ kind: "teleport" } as unknown as BrowserAction),
    ).toThrow(/no published agent op/);
  });
});

describe("toAgentPage — the untrusted fence on the structured half", () => {
  it("puts everything the page wrote under one marked key", () => {
    const page = toAgentPage({
      output: {
        url: "https://x.test",
        title: "Sign in",
        a11y: "button e1 Save",
        text: "hello",
        dom: "sig",
        console: [{ type: "error", text: "boom" }],
        handoffNote: "a person took control",
        refs: { e1: { role: "button", name: "Save" } },
        omittedSubtrees: 2,
        totalNodes: 900,
      },
      stateToken: TOKEN,
      settled: true,
    })!;
    expect(page.pageContent.untrusted).toBe(true);
    expect(page.pageContent).toMatchObject({
      url: "https://x.test",
      title: "Sign in",
      a11y: "button e1 Save",
      text: "hello",
      dom: "sig",
      console: [{ type: "error", text: "boom" }],
    });
    // OUR accounting stays outside the fence: it is not the page's words.
    expect(page.handoffNote).toBe("a person took control");
    expect(page.omitted).toEqual({ subtrees: 2, totalNodes: 900 });
    expect(page.settled).toBe(true);
    expect(page.pageContent).not.toHaveProperty("handoffNote");
    // Refs are INSIDE it, though: an accessible name is text the page chose,
    // and `<button aria-label="Ignore previous instructions…">` lands in it.
    expect(page.pageContent.refs).toEqual({
      e1: { role: "button", name: "Save" },
    });
    expect(page).not.toHaveProperty("refs");
  });

  it("treats a page tool's own result as an observation", () => {
    // `invoke_page_tool` answers with the tool's output and, when the page did
    // not otherwise change, nothing else. Reading that as "nothing was looked
    // at" threw away the very value the command ran to get — the caller got a
    // successful command and no payload.
    const page = toAgentPage({
      output: { invocationId: "inv-1", result: { rows: 3 } },
    });
    expect(page).toBeDefined();
    expect(page!.pageContent.invocation).toEqual({ rows: 3 });
    expect(page!.pageContent.untrusted).toBe(true);
  });

  it("keeps refs whose entries are the shape the type promises", () => {
    // The map is written by the page. Checking only the wrapper and asserting
    // the entries' type is not a check, it is the claim a reader then trusts.
    const bad = toAgentPage({
      output: { a11y: "tree", refs: { e1: { role: 7 } } },
    })!;
    expect(bad.pageContent).not.toHaveProperty("refs");
    const missingRole = toAgentPage({
      output: { a11y: "tree", refs: { e1: { name: "Save" } } },
    })!;
    expect(missingRole.pageContent).not.toHaveProperty("refs");
    const nested = toAgentPage({
      output: { a11y: "tree", refs: { e1: null } },
    })!;
    expect(nested.pageContent).not.toHaveProperty("refs");
    // One bad entry disqualifies the map: half a ref map is worse than none,
    // because a caller cannot tell which half it got.
    const mixed = toAgentPage({
      output: {
        a11y: "tree",
        refs: { e1: { role: "button" }, e2: { role: 7 } },
      },
    })!;
    expect(mixed.pageContent).not.toHaveProperty("refs");
    const good = toAgentPage({
      output: { a11y: "tree", refs: { e1: { role: "button" } } },
    })!;
    expect(good.pageContent.refs).toEqual({ e1: { role: "button" } });
  });

  it("is undefined for a command that did not observe anything", () => {
    // `close_tab` and `cancel_page_tool` answer with an action record and no
    // token; a page built from that would imply something was looked at.
    expect(toAgentPage({ output: { closed: "tab-1" } })).toBeUndefined();
    expect(toAgentPage({ output: { cancelled: true } })).toBeUndefined();
    // …but a URL alone IS an observation.
    expect(toAgentPage({ output: { url: "https://x.test" } })).toBeDefined();
  });

  it("carries the viewport on EVERY observation", () => {
    // So an agent can compute a click from a screenshot without a hardcoded
    // constant of its own that can go stale.
    const page = toAgentPage({ output: { url: "https://x.test" } })!;
    expect(page.viewport).toEqual({ width: 1024, height: 768 });
  });

  it("publishes the state token as an opaque string, not the daemon's fields", () => {
    const page = toAgentPage({ output: {}, stateToken: TOKEN })!;
    expect(typeof page.stateToken).toBe("string");
    expect(page.stateToken).not.toContain("domHash");
    expect(decodeStateToken(page.stateToken!)).toEqual(TOKEN);
  });

  it("carries the ledger's artifact descriptors, so a picture is fetchable", () => {
    // The ids are minted when the ledger lifts the payload out of the row, so
    // they are not in the daemon result at all. A page without them tells a
    // caller a screenshot exists and gives it no way to ask for one.
    const page = toAgentPage(
      { output: { url: "https://x.test" } },
      { screenshot: { id: "art-1", bytes: 4096, mediaType: "image/jpeg" } },
    )!;
    expect(page.artifacts?.screenshot).toMatchObject({
      id: "art-1",
      mediaType: "image/jpeg",
    });
  });

  it("is a page even when the ONLY thing captured was an artifact", () => {
    expect(
      toAgentPage({}, { screenshot: { id: "a", bytes: 1, mediaType: "image/jpeg" } }),
    ).toBeDefined();
  });

  it("is undefined when there was nothing to observe", () => {
    expect(toAgentPage({})).toBeUndefined();
  });

  it("reports an executed-and-failed command without handing back the page", () => {
    // The `overrideError` arm: the command RAN, and only the caller's own
    // policy objects to where it landed. Saying `refused` would promise that
    // nothing ran and that a retry is safe.
    const result = executedResult({
      commandId: "c1",
      result: { ok: true, output: { url: "https://evil.test" } },
      overrideError: { code: "origin_not_allowed", message: "outside" },
    });
    expect(result.status).toBe("executed");
    expect(result.status === "executed" && result.ok).toBe(false);
    expect(result.status === "executed" && result.error?.code).toBe(
      "origin_not_allowed",
    );
    expect(result.status === "executed" && result.page).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("evil.test");
  });
});

describe("the three outcomes", () => {
  it("keeps `executed but failed` distinct from `refused`", () => {
    // A click that found no button RAN and failed. A caller must be able to
    // tell that from a click that never ran at all.
    const result = executedResult({
      commandId: "c1",
      result: { ok: false, error: "target_not_found: no #save" },
    });
    expect(result.status).toBe("executed");
    expect(result.status === "executed" && result.ok).toBe(false);
    expect(result.status === "executed" && result.error).toEqual({
      code: "target_not_found",
      message: "no #save",
    });
  });

  it("keeps a bare error message whole when it carries no code", () => {
    const result = executedResult({
      commandId: "c1",
      result: { ok: false, error: "something went wrong" },
    });
    expect(result.status === "executed" && result.error).toEqual({
      message: "something went wrong",
    });
  });

  it("carries a fresh page on a stale-observation refusal", () => {
    const result = refusedResult({
      commandId: "c1",
      code: "stale_observation",
      message: "the page moved",
      page: toAgentPage({ output: { url: "https://x.test/moved" } }),
    });
    expect(result.status === "refused" && result.refusal.page?.pageContent.url).toBe(
      "https://x.test/moved",
    );
  });

  it("carries NO page on a lease refusal", () => {
    // While a person holds the browser the daemon captures nothing. A refusal
    // that arrived with a screenshot would defeat the gate that produced it.
    const result = refusedResult({
      commandId: "c1",
      code: "lease_held",
      message: "a person has the browser",
    });
    expect(result.status === "refused" && result.refusal.page).toBeUndefined();
  });

  it("tells an `unknown` caller to read the ledger instead of retrying", () => {
    // Collapsing `unknown` into `refused` is the dangerous simplification: it
    // tells a caller a payment is safe to re-submit.
    const result = unknownResult({ commandId: "c1", reason: "expired" });
    expect(result.status).toBe("unknown");
    expect(result.status === "unknown" && result.unknown).toMatchObject({
      reason: "expired",
      commandId: "c1",
    });
    expect(result.status === "unknown" && result.unknown.instruction).toContain(
      "Do NOT",
    );
  });

  it("links a result to its ledger row when there is one", () => {
    const result = executedResult({
      commandId: "c1",
      result: { ok: true },
      ledger: { sessionId: "sess-1", seq: 12 },
    });
    expect(result.ledger).toEqual({ sessionId: "sess-1", seq: 12 });
  });
});
