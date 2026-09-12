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

  it("leaves the screenshot alone", async () => {
    // Base64 image data: a registered value cannot meaningfully occur in it,
    // and scanning a megabyte per observation for a needle that cannot be
    // there is pure cost.
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
