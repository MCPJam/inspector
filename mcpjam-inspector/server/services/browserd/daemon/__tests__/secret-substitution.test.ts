/**
 * The daemon half of `{{secret:NAME}}`: substitute in, scrub out.
 *
 * The two have to be tested together because the invariant only exists in
 * their composition — a value goes onto the page and must not come back off
 * it. Either half alone looks fine while the pair leaks.
 */
import { describe, expect, it, vi } from "vitest";
import { createBrowserSecretRegistry } from "../secret-registry";
import { resolveActSecrets } from "../secret-substitution";
import { withSecretScrub } from "../browser-driver";
import { ChromiumDriver } from "../chromium-driver";
import { fakeContext, fakePage } from "./fake-page";
import type { BrowserAction, BrowserCommand } from "../../protocol";

const PASSWORD = "hunter2-hunter2-hunter2";

function act(over: Partial<Extract<BrowserAction, { kind: "act" }>> = {}) {
  return { kind: "act", verb: "type", ...over } as Extract<
    BrowserAction,
    { kind: "act" }
  >;
}

describe("resolveActSecrets", () => {
  it("returns the SAME OBJECT when nothing was substituted", () => {
    // The caller's "did anything resolve?" test is identity, and a fresh
    // object on every act would register secrets for commands that used none.
    const action = act({ value: "plain" });
    expect(resolveActSecrets(action, [{ name: "P", value: PASSWORD }])).toBe(
      action,
    );
  });

  it("substitutes into value", () => {
    const out = resolveActSecrets(act({ value: "{{secret:P}}" }), [
      { name: "P", value: PASSWORD },
    ]);
    expect(out.value).toBe(PASSWORD);
  });

  it("substitutes into fill_form fields, leaving the rest alone", () => {
    const out = resolveActSecrets(
      act({
        verb: "fill_form",
        fields: [
          { selector: "#user", value: "alex" },
          { selector: "#pw", value: "{{secret:P}}" },
        ],
      }),
      [{ name: "P", value: PASSWORD }],
    );
    expect(out.fields?.map((f) => f.value)).toEqual(["alex", PASSWORD]);
    expect(out.fields?.[0]?.selector).toBe("#user");
  });

  it("substitutes a placeholder EMBEDDED in a longer value", () => {
    const out = resolveActSecrets(act({ value: "user-{{secret:P}}@x.test" }), [
      { name: "P", value: PASSWORD },
    ]);
    expect(out.value).toBe(`user-${PASSWORD}@x.test`);
  });

  it("THROWS rather than typing a literal placeholder", () => {
    // The failure this module exists to prevent: a `{{secret:X}}` in somebody's
    // login form, reported as success, read by the model as a wrong password.
    expect(() => resolveActSecrets(act({ value: "{{secret:P}}" }), [])).toThrow(
      /secret_unresolved/,
    );
    expect(() =>
      resolveActSecrets(act({ value: "{{secret:P}}" }), undefined),
    ).toThrow(/secret_unresolved/);
  });

  it("throws for an unresolved FIELD as well as an unresolved value", () => {
    expect(() =>
      resolveActSecrets(
        act({
          verb: "fill_form",
          fields: [{ selector: "#pw", value: "{{secret:P}}" }],
        }),
        [{ name: "OTHER", value: PASSWORD }],
      ),
    ).toThrow(/secret_unresolved/);
  });

  it("never puts a VALUE in the refusal", () => {
    let message = "";
    try {
      resolveActSecrets(act({ value: "{{secret:P}}" }), [
        { name: "OTHER", value: PASSWORD },
      ]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain(PASSWORD);
  });
});

describe("createBrowserSecretRegistry", () => {
  it("has no scrubber until something is registered", () => {
    // The overwhelmingly common session, and it must cost nothing.
    expect(createBrowserSecretRegistry().scrubber()).toBeNull();
  });

  it("replaces a registered value with the placeholder the model wrote", () => {
    const registry = createBrowserSecretRegistry();
    registry.register([{ name: "P", value: PASSWORD }]);
    expect(registry.scrubber()?.scrubString(`value=${PASSWORD}`)).toBe(
      "value={{secret:P}}",
    );
  });

  it("keys by VALUE, so one credential under two names registers once", () => {
    const registry = createBrowserSecretRegistry();
    registry.register([{ name: "A", value: PASSWORD }]);
    registry.register([{ name: "B", value: PASSWORD }]);
    expect(registry.size).toBe(1);
  });

  it("keeps registrations for the whole boot, not for one command", () => {
    // An observation three commands later reads the same field; forgetting
    // after the typing command would scrub exactly one observation.
    const registry = createBrowserSecretRegistry();
    registry.register([{ name: "P", value: PASSWORD }]);
    registry.register([{ name: "Q", value: "second-value-long" }]);
    expect(registry.scrubber()?.scrubString(PASSWORD)).toBe("{{secret:P}}");
  });

  it("offers a SHORT value for masking rather than scrubbing", () => {
    // A four-character value replaced everywhere would corrupt unrelated page
    // text; in a field's `value` an exact match is not a coincidence.
    const registry = createBrowserSecretRegistry();
    registry.register([{ name: "PIN", value: "1234" }]);
    expect(registry.scrubber()).toBeNull();
    expect([...registry.maskedValues()]).toEqual([["1234", "{{secret:PIN}}"]]);
  });

  it("ignores an empty value", () => {
    const registry = createBrowserSecretRegistry();
    registry.register([{ name: "EMPTY", value: "" }]);
    expect(registry.size).toBe(0);
  });

  it("answers exposure per PAGE, not per session", () => {
    // The picture has to come back when the page moves on. A login flow whose
    // every screenshot after the password field is blank is a worse agent, not
    // a safer one — and the submit is the navigation a model most needs to see
    // the result of.
    const registry = createBrowserSecretRegistry();
    registry.register([{ name: "P", value: PASSWORD }]);
    registry.markTyped("https://app.test/login");
    expect(registry.exposedAt("https://app.test/login")).toBe(true);
    expect(registry.exposedAt("https://app.test/home")).toBe(false);
  });

  it("says nothing is exposed until something is typed", () => {
    // Registered is not typed: the server's belt registers values it never
    // put on a page, and suppressing pictures for those would be a blackout
    // bought with nothing.
    const registry = createBrowserSecretRegistry();
    registry.register([{ name: "P", value: PASSWORD }]);
    expect(registry.exposedAt("https://app.test/login")).toBe(false);
    expect(registry.exposedAt(undefined)).toBe(false);
  });

  it("treats a typing it could not place as exposure everywhere", () => {
    // The act typed a value and then could not read the page it typed into.
    // "Somewhere" is the only honest answer, and the safe one.
    const registry = createBrowserSecretRegistry();
    registry.register([{ name: "P", value: PASSWORD }]);
    registry.markTyped(undefined);
    expect(registry.exposedAt("https://app.test/anywhere")).toBe(true);
    expect(registry.exposedAt(undefined)).toBe(true);
  });

  it("cannot clear a result that names no page", () => {
    const registry = createBrowserSecretRegistry();
    registry.register([{ name: "P", value: PASSWORD }]);
    registry.markTyped("https://app.test/login");
    expect(registry.exposedAt(undefined)).toBe(true);
    expect(registry.exposedAt("")).toBe(true);
  });
});

describe("withSecretScrub", () => {
  const command = {
    commandId: "c1",
    source: "chat",
    action: { kind: "observe" },
  } as unknown as BrowserCommand;

  it("does nothing, and allocates nothing, when nothing is registered", async () => {
    const registry = createBrowserSecretRegistry();
    const result = { ok: true, output: { a11y: `text ${PASSWORD}` } };
    const wrapped = withSecretScrub(registry, async () => result);
    expect(await wrapped(command)).toBe(result);
  });

  it("scrubs the value out of a nested output", async () => {
    const registry = createBrowserSecretRegistry();
    registry.register([{ name: "P", value: PASSWORD }]);
    const wrapped = withSecretScrub(registry, async () => ({
      ok: true,
      output: {
        a11y: `textbox "Password" value=${PASSWORD}`,
        console: [{ text: `sent ${PASSWORD}` }],
      },
    }));
    const result = await wrapped(command);
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(JSON.stringify(result)).toContain("{{secret:P}}");
  });

  it("scrubs an error message too", async () => {
    const registry = createBrowserSecretRegistry();
    registry.register([{ name: "P", value: PASSWORD }]);
    const wrapped = withSecretScrub(registry, async () => ({
      ok: false,
      error: `navigation failed: ?token=${PASSWORD}`,
    }));
    expect((await wrapped(command)).error).toBe(
      "navigation failed: ?token={{secret:P}}",
    );
  });

  it("never SCRUBS the screenshot, on a page nothing was typed into", async () => {
    // Base64 image data: a registered value cannot meaningfully occur in it,
    // and scanning a megabyte per observation for a needle that cannot be
    // there is pure cost. A value registered but typed nowhere — the belt-side
    // case, a page somebody signed into before this browser existed — leaves
    // the picture exactly as the driver took it.
    const registry = createBrowserSecretRegistry();
    registry.register([{ name: "P", value: PASSWORD }]);
    const screenshot = "AAAA".repeat(1000);
    const wrapped = withSecretScrub(registry, async () => ({
      ok: true,
      output: { screenshot, a11y: PASSWORD },
    }));
    const output = (await wrapped(command)).output as Record<string, unknown>;
    expect(output.screenshot).toBe(screenshot);
    expect(output.a11y).toBe("{{secret:P}}");
  });

  it("DROPS a later screenshot of the page the value was typed into", async () => {
    // THE LEAK THE SCRUB CANNOT REACH. A site that does not mask its field
    // renders the credential, and a picture is not a string — so a screenshot
    // one command later would carry it into the model's context, the ledger
    // row and the eval trace past every replacement in this file.
    const registry = createBrowserSecretRegistry();
    registry.register([{ name: "P", value: PASSWORD }]);
    registry.markTyped("https://app.test/login");
    const wrapped = withSecretScrub(registry, async () => ({
      ok: true,
      output: {
        url: "https://app.test/login",
        screenshot: "AAAA".repeat(1000),
        a11y: `textbox "Password" value=${PASSWORD}`,
      },
    }));
    const output = (await wrapped(command)).output as Record<string, unknown>;
    expect(output.screenshot).toBeUndefined();
    expect(output.screenshotSuppressed).toBe(true);
    // Everything else still arrives, scrubbed — the model loses the picture,
    // not the page.
    expect(output.a11y).toBe('textbox "Password" value={{secret:P}}');
    expect(output.url).toBe("https://app.test/login");
  });

  it("gives the picture back once the page moves on", async () => {
    // A blackout for the rest of the session would be a worse agent, not a
    // safer one: the submit is the one navigation a model most needs to see
    // the result of.
    const registry = createBrowserSecretRegistry();
    registry.register([{ name: "P", value: PASSWORD }]);
    registry.markTyped("https://app.test/login");
    const screenshot = "AAAA".repeat(1000);
    const wrapped = withSecretScrub(registry, async () => ({
      ok: true,
      output: { url: "https://app.test/dashboard", screenshot },
    }));
    const output = (await wrapped(command)).output as Record<string, unknown>;
    expect(output.screenshot).toBe(screenshot);
    expect(output.screenshotSuppressed).toBeUndefined();
  });

  it("drops a screenshot nobody can place", async () => {
    // A result with no `url` is a capture nobody can clear: the observation
    // funnel attaches one to everything it can read, so no URL means the page
    // could not be read — which is not evidence that it moved.
    const registry = createBrowserSecretRegistry();
    registry.register([{ name: "P", value: PASSWORD }]);
    registry.markTyped("https://app.test/login");
    const wrapped = withSecretScrub(registry, async () => ({
      ok: true,
      output: { screenshot: "AAAA".repeat(1000), observationFailed: true },
    }));
    const output = (await wrapped(command)).output as Record<string, unknown>;
    expect(output.screenshot).toBeUndefined();
    expect(output.screenshotSuppressed).toBe(true);
  });

  it("suppresses nothing when no value was ever typed", async () => {
    // The bar the whole feature is held to: a session that uses no secret gets
    // the driver's own object back, identity and all.
    const registry = createBrowserSecretRegistry();
    const result = {
      ok: true,
      output: { url: "https://app.test/login", screenshot: "AAAA" },
    };
    const wrapped = withSecretScrub(registry, async () => result);
    expect(await wrapped(command)).toBe(result);
  });

  it("scrubs a string output", async () => {
    const registry = createBrowserSecretRegistry();
    registry.register([{ name: "P", value: PASSWORD }]);
    const wrapped = withSecretScrub(registry, async () => ({
      ok: true,
      output: PASSWORD,
    }));
    expect((await wrapped(command)).output).toBe("{{secret:P}}");
  });

  it("passes the context through to the wrapped executor", async () => {
    // The values travel BESIDE the command; dropping them here would leave the
    // driver with a placeholder and no value.
    const executor = vi.fn(async () => ({ ok: true }));
    const wrapped = withSecretScrub(createBrowserSecretRegistry(), executor);
    const context = { secrets: [{ name: "P", value: PASSWORD }] };
    await wrapped(command, context);
    expect(executor).toHaveBeenCalledWith(command, context);
  });
});

/**
 * The registry, the driver and the wrapper, composed the way `server.ts`
 * composes them.
 *
 * Each half is already covered alone, and each half alone is exactly what
 * cannot be trusted here: a driver that records the page it typed into and a
 * wrapper that reads a registry nobody wrote are both green, and together they
 * hand the model a picture of the password.
 */
describe("secret exposure, through the driver", () => {
  const step = (action: unknown): BrowserCommand =>
    ({
      commandId: `c-${Math.random()}`,
      source: "chat",
      action,
    }) as unknown as BrowserCommand;

  function stack() {
    const page = fakePage({ url: "https://app.test/login" });
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    const registry = driver.secretRegistry();
    const wrapped = withSecretScrub(registry, (command, ctx) =>
      ctx ? driver.execute(command, ctx) : driver.execute(command),
    );
    return { page, driver, registry, wrapped };
  }

  const typeSecret = {
    kind: "act",
    verb: "type",
    target: { selector: "#pw" },
    value: "{{secret:P}}",
    observe: "none",
  };

  it("suppresses the screenshot of the page it typed into, and only that page", async () => {
    const { page, wrapped } = stack();
    await wrapped(step({ kind: "navigate", url: "https://app.test/login" }));
    const typed = await wrapped(step(typeSecret), {
      secrets: [{ name: "P", value: PASSWORD }],
    });
    expect(typed.ok).toBe(true);
    // The value reached the page — the substitution working, and the reason
    // the picture is now dangerous.
    expect(page.calls.acts).toEqual([`fill:#pw:${PASSWORD}`]);

    const during = (
      await wrapped(step({ kind: "observe", mode: "screenshot" }))
    ).output as Record<string, unknown>;
    expect(during.screenshot).toBeUndefined();
    expect(during.screenshotSuppressed).toBe(true);

    await wrapped(step({ kind: "navigate", url: "https://app.test/home" }));
    const after = (await wrapped(step({ kind: "observe", mode: "screenshot" })))
      .output as Record<string, unknown>;
    expect(after.screenshot).toBeTruthy();
    expect(after.screenshotSuppressed).toBeUndefined();
  });

  it("records nothing when the act carried no placeholder", async () => {
    // A `type` of a plain string with a secret sitting in the turn's bag: the
    // registry is written at SUBSTITUTION, so nothing resolved means nothing
    // typed, nothing scrubbed and nothing suppressed.
    const { registry, wrapped } = stack();
    await wrapped(step({ kind: "navigate", url: "https://app.test/login" }));
    await wrapped(
      step({
        kind: "act",
        verb: "type",
        target: { selector: "#q" },
        value: "hello",
        observe: "none",
      }),
      { secrets: [{ name: "P", value: PASSWORD }] },
    );
    expect(registry.size).toBe(0);
    expect(registry.exposedAt("https://app.test/login")).toBe(false);
    const shot = (await wrapped(step({ kind: "observe", mode: "screenshot" })))
      .output as Record<string, unknown>;
    expect(shot.screenshot).toBeTruthy();
  });
});
