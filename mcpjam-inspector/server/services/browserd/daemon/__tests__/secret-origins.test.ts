/**
 * A secret sent with `origins` is typed only on a page at one of them, and a
 * reviewer credential only ever with them. Everything else types as it always
 * has. The refusal is the act's result, so the ledger records it.
 */
import { describe, expect, it, vi } from "vitest";
import { resolveActSecrets } from "../secret-substitution";
import { withSecretScrub } from "../browser-driver";
import { ChromiumDriver } from "../chromium-driver";
import { BrowserdRequestHandler } from "../request-handler";
import { CommandLedger, type BrowserLedgerRow } from "../command-ledger";
import { HandoffLease } from "../lease";
import { BROWSERD_WEBMCP_FEATURES } from "../../protocol";
import type { BrowserAction, BrowserCommand } from "../../protocol";
import { fakeContext, fakePage } from "./fake-page";

const PASSWORD = "reviewer-password-sample-1";
const AUTH = "https://auth.example.com";
const REVIEWER = "MCPJAM_REVIEWER_SUB_PASSWORD";

function typeAct(value = `{{secret:${REVIEWER}}}`) {
  return { kind: "act", verb: "type", value } as Extract<
    BrowserAction,
    { kind: "act" }
  >;
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
    for (const page of ["https://auth.example.com.evil.test/", "about:blank", undefined]) {
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
      resolveActSecrets(typeAct(), [{ name: REVIEWER, value: PASSWORD }], `${AUTH}/login`),
    );
    expect(message).toMatch(/^secret_origin_refused: /);
    expect(message).not.toContain(PASSWORD);
    // An empty list limits any secret to no page.
    expect(() =>
      resolveActSecrets(typeAct("{{secret:P}}"), [{ name: "P", value: PASSWORD, origins: [] }], `${AUTH}/`),
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
      (command, ctx) => (ctx ? driver.execute(command, ctx) : driver.execute(command)),
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
    await wrapped(step({ kind: "navigate", url: "https://collector.test/login" }));
    const out = await wrapped(step(typePassword), {
      secrets: [{ name: REVIEWER, value: PASSWORD, origins: [AUTH] }],
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/^secret_origin_refused: /);
    expect(page.calls.acts).toEqual([]);
    expect(registry.hasExposure()).toBe(false);
  });

  it("types it on the allowed origin", async () => {
    const { page, wrapped } = stack(`${AUTH}/login`);
    await wrapped(step({ kind: "navigate", url: `${AUTH}/login` }));
    const out = await wrapped(step(typePassword), {
      secrets: [{ name: REVIEWER, value: PASSWORD, origins: [AUTH] }],
    });
    expect(out.ok).toBe(true);
    expect(page.calls.acts).toEqual([`fill:#pw:${PASSWORD}`]);
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
    await handler.handle(post([{ name: REVIEWER, value: PASSWORD, origins: [AUTH] }]));
    const [row] = ledger
      .read({ limit: 10 })
      .entries.filter((entry): entry is BrowserLedgerRow => entry.kind === "command");
    expect(row).toMatchObject({ ok: false, errorCode: "secret_origin_refused" });
    expect(JSON.stringify(ledger.read({ limit: 10 }))).not.toContain(PASSWORD);
  });

  it("announces the feature, so a server checks before sending origins", () => {
    expect(BROWSERD_WEBMCP_FEATURES).toContain("secret-origins");
  });
});
