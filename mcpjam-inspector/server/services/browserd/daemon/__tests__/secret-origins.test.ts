/**
 * A secret sent with `origins` is typed only on a page at one of them, and a
 * reviewer credential only ever with them. Everything else types as it always
 * has. The refusal is the act's result, so the ledger records it.
 */
import { describe, expect, it, vi } from "vitest";
import {
  receivingFrameRefusal,
  resolveActSecrets,
  secretReceivingOrigins,
} from "../secret-substitution";
import { withSecretScrub } from "../browser-driver";
import { ChromiumDriver } from "../chromium-driver";
import { insertSecretInNode, SecretNotTypedError } from "../node-target";
import { secretDeliveryOutcome } from "../../../../utils/built-in-tools/browser-caller-options";
import { BrowserdRequestHandler } from "../request-handler";
import { CommandLedger, type BrowserLedgerRow } from "../command-ledger";
import { HandoffLease } from "../lease";
import { BROWSERD_WEBMCP_FEATURES } from "../../protocol";
import type { BrowserAction, BrowserCommand } from "../../protocol";
import { axTree, fakeContext, fakePage } from "./fake-page";

const PASSWORD = "reviewer-password-sample-1";
const AUTH = "https://auth.example.com";
const REVIEWER = "MCPJAM_REVIEWER_SUB_PASSWORD";

function typeAct(value = `{{secret:${REVIEWER}}}`) {
  return {
    kind: "act",
    verb: "type",
    target: { a11yRef: "e1" },
    value,
  } as Extract<BrowserAction, { kind: "act" }>;
}

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("resolveActSecrets with origins", () => {
  const limited = [{ name: REVIEWER, value: PASSWORD, origins: [AUTH] }];

  it("types a limited secret on a page at an allowed origin", () => {
    const out = resolveActSecrets(typeAct(), limited, `${AUTH}/login?step=1`);
    expect(out.value).toBe(PASSWORD);
  });

  it("refuses it on any other page, naming origins and never the value", () => {
    const message = refusal(() =>
      resolveActSecrets(typeAct(), limited, "https://collector.test/form"),
    );
    expect(message).toMatch(/^secret_origin_refused: /);
    expect(message).toContain(AUTH);
    expect(message).toContain("https://collector.test");
    expect(message).not.toContain(PASSWORD);
    // A look-alike host and a page with no origin are other pages too.
    for (const page of [
      "https://auth.example.com.evil.test/",
      "about:blank",
      undefined,
    ]) {
      expect(() => resolveActSecrets(typeAct(), limited, page)).toThrow(
        /secret_origin_refused/,
      );
    }
  });

  it("refuses a limited secret in a fill_form field as well", () => {
    const action = {
      kind: "act",
      verb: "fill_form",
      fields: [{ selector: "#pw", value: `{{secret:${REVIEWER}}}` }],
    } as Extract<BrowserAction, { kind: "act" }>;
    expect(() =>
      resolveActSecrets(action, limited, "https://collector.test/"),
    ).toThrow(/secret_origin_refused/);
  });

  it("types a reviewer credential sent with no origins nowhere", () => {
    const message = refusal(() =>
      resolveActSecrets(
        typeAct(),
        [{ name: REVIEWER, value: PASSWORD }],
        `${AUTH}/login`,
      ),
    );
    expect(message).toMatch(/^secret_origin_refused: /);
    expect(message).not.toContain(PASSWORD);
    // An empty list limits any secret to no page.
    expect(() =>
      resolveActSecrets(
        typeAct("{{secret:P}}"),
        [{ name: "P", value: PASSWORD, origins: [] }],
        `${AUTH}/`,
      ),
    ).toThrow(/secret_origin_refused/);
  });

  it("keeps typing a secret with no origins on any page, as before", () => {
    const out = resolveActSecrets(
      typeAct("{{secret:STRIPE_KEY}}"),
      [{ name: "STRIPE_KEY", value: PASSWORD }],
      "https://dashboard.stripe.test/login",
    );
    expect(out.value).toBe(PASSWORD);
  });
});

describe("secret origins, through the driver", () => {
  const step = (action: unknown): BrowserCommand =>
    ({ commandId: `c-${Math.random()}`, source: "agent", action }) as never;

  function stack(url: string) {
    const page = fakePage({ url });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    const registry = driver.secretRegistry();
    const wrapped = withSecretScrub(
      registry,
      (command, ctx) =>
        ctx ? driver.execute(command, ctx) : driver.execute(command),
      (tabId) => driver.documentKey(tabId),
    );
    return { page, registry, wrapped };
  }

  const typePassword = {
    kind: "act",
    verb: "type",
    target: { selector: "#pw" },
    value: `{{secret:${REVIEWER}}}`,
    observe: "none",
  };

  it("types nothing and registers nothing on a page outside the origins", async () => {
    const { page, registry, wrapped } = stack("https://collector.test/login");
    await wrapped(
      step({ kind: "navigate", url: "https://collector.test/login" }),
    );
    const out = await wrapped(step(typePassword), {
      secrets: [{ name: REVIEWER, value: PASSWORD, origins: [AUTH] }],
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/^secret_origin_refused: /);
    expect(page.calls.acts).toEqual([]);
    expect(registry.hasExposure()).toBe(false);
  });

  it("types it on the allowed origin only into a ref'd field, never by selector", async () => {
    const { page, registry, wrapped } = stack(`${AUTH}/login`);
    await wrapped(step({ kind: "navigate", url: `${AUTH}/login` }));
    const out = await wrapped(step(typePassword), {
      secrets: [{ name: REVIEWER, value: PASSWORD, origins: [AUTH] }],
    });
    // A selector can reach into another site's frame; a ref names the field.
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/secret_origin_refused: .*ref/);
    expect(page.calls.acts).toEqual([]);
    expect(String(out.error)).not.toContain(PASSWORD);
    expect(registry).toBeDefined();
  });
});

describe("the request handler and secret origins", () => {
  const TOKEN = "per-boot-token-sample";

  function handlerWith(submit: ReturnType<typeof vi.fn>) {
    const ledger = new CommandLedger({ bootId: "boot-1" });
    const handler = new BrowserdRequestHandler({
      queue: { submit },
      driver: { health: async () => ({ ok: true as const }) },
      bootId: "boot-1",
      token: TOKEN,
      lease: new HandoffLease(),
      ledger,
    });
    return { handler, ledger };
  }

  const post = (secrets: unknown) => ({
    method: "POST",
    path: "/v1/commands",
    origin: undefined,
    authorization: `Bearer ${TOKEN}`,
    body: JSON.stringify({
      command: { commandId: "c1", source: "agent", action: typeAct() },
      secrets,
    }),
  });

  it("passes exact origins through, and limits a malformed list to no page", async () => {
    const submit = vi.fn(async () => ({
      status: "ok" as const,
      result: { ok: true },
      bootId: "boot-1",
    }));
    const { handler } = handlerWith(submit);
    await handler.handle(
      post([
        { name: "A", value: PASSWORD, origins: [AUTH, `${AUTH}/path`, 7] },
        { name: "B", value: PASSWORD, origins: AUTH },
        { name: "C", value: PASSWORD },
      ]),
    );
    expect(submit.mock.calls[0]![1]).toEqual({
      secrets: [
        { name: "A", value: PASSWORD, origins: [AUTH] },
        { name: "B", value: PASSWORD, origins: [] },
        { name: "C", value: PASSWORD },
      ],
    });
  });

  it("records the refusal in the ledger, by code", async () => {
    const submit = vi.fn(async () => ({
      status: "ok" as const,
      result: { ok: false, error: "secret_origin_refused: nothing was typed" },
      bootId: "boot-1",
    }));
    const { handler, ledger } = handlerWith(submit);
    await handler.handle(
      post([{ name: REVIEWER, value: PASSWORD, origins: [AUTH] }]),
    );
    const [row] = ledger
      .read({ limit: 10 })
      .entries.filter(
        (entry): entry is BrowserLedgerRow => entry.kind === "command",
      );
    expect(row).toMatchObject({
      ok: false,
      errorCode: "secret_origin_refused",
    });
    expect(JSON.stringify(ledger.read({ limit: 10 }))).not.toContain(PASSWORD);
  });

  it("announces the feature, so a server checks before sending origins", () => {
    expect(BROWSERD_WEBMCP_FEATURES).toContain("secret-origins");
  });
});

describe("the field's own document", () => {
  const limited = [{ name: REVIEWER, value: PASSWORD, origins: [AUTH] }];

  /** A CDP session whose frame tree has a framed child on `framed`. */
  const cdpWith = (framed: string, root = AUTH) => ({
    on: () => {},
    send: vi.fn(async () => ({
      frameTree: {
        frame: { id: "main", securityOrigin: root },
        childFrames: [{ frame: { id: "child", securityOrigin: framed } }],
      },
    })),
  });

  it("refuses a limited credential on any verb but a ref'd type, a dialog reply included", () => {
    for (const action of [
      { kind: "act", verb: "accept_dialog", value: `{{secret:${REVIEWER}}}` },
      {
        kind: "act",
        verb: "type",
        target: { selector: "#pw" },
        value: `{{secret:${REVIEWER}}}`,
      },
      { kind: "act", verb: "type", value: `{{secret:${REVIEWER}}}` },
    ]) {
      const message = refusal(() =>
        resolveActSecrets(action as never, limited, `${AUTH}/login`),
      );
      expect(message).toMatch(/^secret_origin_refused: .*ref/);
      expect(message).not.toContain(PASSWORD);
    }
  });

  it("names where a substituted act's limited credential may land", () => {
    const out = resolveActSecrets(typeAct(), limited, `${AUTH}/login`);
    expect(secretReceivingOrigins(out)).toEqual([AUTH]);
    const unlimited = resolveActSecrets(
      typeAct("{{secret:STRIPE_KEY}}"),
      [{ name: "STRIPE_KEY", value: PASSWORD }],
      "https://dashboard.stripe.test/",
    );
    expect(secretReceivingOrigins(unlimited)).toBeUndefined();
  });

  it("allows a field in a frame on an allowed origin", async () => {
    const cdp = cdpWith("https://collector.test");
    expect(await receivingFrameRefusal(cdp, undefined, [AUTH])).toBeUndefined();
    expect(
      await receivingFrameRefusal(cdpWith(AUTH), "child", [AUTH]),
    ).toBeUndefined();
  });

  it("refuses a field framed in from another origin, or one it cannot read", async () => {
    const framed = await receivingFrameRefusal(
      cdpWith("https://collector.test"),
      "child",
      [AUTH],
    );
    expect(framed).toContain("https://collector.test");
    expect(framed).toContain(AUTH);
    expect(
      await receivingFrameRefusal(cdpWith("://null"), "missing", [AUTH]),
    ).toMatch(/could not read/);
    const broken = {
      on: () => {},
      send: vi.fn(async () => {
        throw new Error("gone");
      }),
    };
    expect(await receivingFrameRefusal(broken, undefined, [AUTH])).toMatch(
      /could not read/,
    );
  });

  it("types a limited credential into nothing without a ref", async () => {
    const page = fakePage({ url: `${AUTH}/login` });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    const step = (action: unknown): BrowserCommand =>
      ({ commandId: `c-${Math.random()}`, source: "agent", action }) as never;
    await driver.execute(step({ kind: "navigate", url: `${AUTH}/login` }));
    const out = await driver.execute(
      step({
        kind: "act",
        verb: "type",
        value: `{{secret:${REVIEWER}}}`,
        observe: "none",
      }),
      { secrets: limited },
    );
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/secret_origin_refused/);
    expect(out.error).not.toContain(PASSWORD);
    expect(page.calls.acts).toEqual([]);
  });
});

describe("a limited credential reaches its field by the field, not by focus", () => {
  function cdpAnswering(value: unknown, resolved = true) {
    const sent: string[] = [];
    const cdp = {
      on: () => {},
      send: vi.fn(
        async (
          method: string,
          params?: {
            frameId?: string;
            executionContextId?: number;
            arguments?: Array<{ value: unknown }>;
          },
        ) => {
          sent.push(method);
          if (method === "Page.getFrameTree")
            return { frameTree: { frame: { id: "main" } } };
          if (method === "Page.createIsolatedWorld") {
            expect(params?.frameId).toBeDefined();
            return { executionContextId: 77 };
          }
          if (method === "DOM.resolveNode") {
            expect(params?.executionContextId).toBe(77);
            return resolved ? { object: { objectId: "field-1" } } : {};
          }
          if (method === "Runtime.callFunctionOn") {
            expect(params?.arguments?.map((arg) => arg.value)).toEqual([
              PASSWORD,
              [AUTH],
            ]);
            return { result: { value } };
          }
          return {};
        },
      ),
    };
    return { cdp, sent };
  }
  const limit = { frameId: "login", origins: [AUTH] };

  it("checks the field's own origin, focuses and inserts in one call, in an isolated world", async () => {
    const { cdp, sent } = cdpAnswering("typed");
    const guard = vi.fn(() => {
      expect(sent).not.toContain("Runtime.callFunctionOn");
    });
    await insertSecretInNode(cdp, 7, PASSWORD, limit, guard);
    expect(guard).toHaveBeenCalledTimes(1);
    // Never through the browser's focus, which a page could move, and never
    // in the page's own world, whose methods a page could replace.
    expect(sent).toEqual([
      "Page.createIsolatedWorld",
      "DOM.resolveNode",
      "Runtime.callFunctionOn",
    ]);
    // The session's own frame when none was named.
    const own = cdpAnswering("typed");
    await insertSecretInNode(
      own.cdp,
      7,
      PASSWORD,
      { origins: [AUTH] },
      () => {},
    );
    expect(own.sent[0]).toBe("Page.getFrameTree");
  });

  it("says nothing was typed only when the field certainly refused it", async () => {
    for (const answer of ["wrong_origin", "not_focused", "not_inserted"]) {
      await expect(
        insertSecretInNode(
          cdpAnswering(answer).cdp,
          7,
          PASSWORD,
          limit,
          () => {},
        ),
      ).rejects.toMatchObject({ code: "unsupported_target" });
    }
    await expect(
      insertSecretInNode(
        cdpAnswering("typed", false).cdp,
        7,
        PASSWORD,
        limit,
        () => {},
      ),
    ).rejects.toMatchObject({ code: "target_not_found" });
    // An answer it cannot read may hide a typed value: no refusal code.
    const unread = insertSecretInNode(
      cdpAnswering(undefined).cdp,
      7,
      PASSWORD,
      limit,
      () => {},
    );
    await expect(unread).rejects.toThrow(/may have been typed/);
    await expect(unread).rejects.not.toBeInstanceOf(SecretNotTypedError);
  });

  it("gives the password try back through the driver only for a certain refusal", async () => {
    const run = async (callFunctionOn: () => unknown) => {
      const page = fakePage({
        url: `${AUTH}/login`,
        cdpReplies: {
          "Accessibility.getFullAXTree": axTree({
            role: "RootWebArea",
            children: [{ role: "textbox", name: "Password", id: 41 }],
          }),
          "Page.getFrameTree": {
            frameTree: { frame: { id: "main", securityOrigin: AUTH } },
          },
          "Page.createIsolatedWorld": { executionContextId: 5 },
          "DOM.resolveNode": { object: { objectId: "field-1" } },
          "Runtime.callFunctionOn": callFunctionOn,
        },
      });
      const { context } = fakeContext({ pages: [page] });
      const driver = new ChromiumDriver(context);
      const step = (action: unknown): BrowserCommand =>
        ({ commandId: `c-${Math.random()}`, source: "agent", action }) as never;
      await driver.execute(step({ kind: "navigate", url: `${AUTH}/login` }));
      await driver.execute(step({ kind: "observe", mode: "a11y" }));
      const result = await driver.execute(
        step({
          kind: "act",
          verb: "type",
          target: { a11yRef: "e1" },
          value: `{{secret:${REVIEWER}}}`,
          observe: "none",
        }),
        { secrets: [{ name: REVIEWER, value: PASSWORD, origins: [AUTH] }] },
      );
      return {
        result,
        outcome: secretDeliveryOutcome({ status: "ok", result }),
      };
    };
    const refused = await run(() => ({ result: { value: "not_focused" } }));
    expect(refused.result.error).toMatch(
      /^unsupported_target: .*nothing was typed/,
    );
    expect(refused.outcome).toBe("not_typed");
    for (const failure of ["Target closed", "Runtime.callFunctionOn timeout"]) {
      const lost = await run(() => {
        throw new Error(failure);
      });
      // The value may have gone in: never read as a field that was not there.
      expect(lost.result.error).toMatch(/^act_failed: /);
      expect(lost.outcome).toBe("unknown");
      expect(JSON.stringify(lost)).not.toContain(PASSWORD);
    }
    expect(JSON.stringify(refused)).not.toContain(PASSWORD);
  });

  it("never types into a node recovered by role and name, which may be in another frame", async () => {
    let tree = axTree({
      role: "RootWebArea",
      children: [{ role: "textbox", name: "Password", id: 41 }],
    });
    const page = fakePage({
      url: `${AUTH}/login`,
      cdpReplies: {
        "Accessibility.getFullAXTree": () => tree,
        "DOM.describeNode": (params?: Record<string, unknown>) => {
          if (params?.backendNodeId === 41) throw new Error("no node with id");
          return {};
        },
        "Page.getFrameTree": {
          frameTree: { frame: { id: "main", securityOrigin: AUTH } },
        },
      },
    });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    const step = (action: unknown): BrowserCommand =>
      ({ commandId: `c-${Math.random()}`, source: "agent", action }) as never;
    await driver.execute(step({ kind: "navigate", url: `${AUTH}/login` }));
    await driver.execute(step({ kind: "observe", mode: "a11y" }));
    // A re-render: the same role and name now on a new node.
    tree = axTree({
      role: "RootWebArea",
      children: [{ role: "textbox", name: "Password", id: 91 }],
    });
    const out = await driver.execute(
      step({
        kind: "act",
        verb: "type",
        target: { a11yRef: "e1" },
        value: `{{secret:${REVIEWER}}}`,
        observe: "none",
      }),
      { secrets: [{ name: REVIEWER, value: PASSWORD, origins: [AUTH] }] },
    );
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/^stale_ref: .*nothing was typed/);
    expect(out.error).not.toContain(PASSWORD);
  });
});
