/**
 * The materialized-secret scrubber.
 *
 * Two things are being pinned, and they pull in opposite directions:
 *   - a REGISTERED value must not survive anywhere in a payload, in any of the
 *     forms it can take after serialization;
 *   - an UNREGISTERED string must come back byte-identical, because tool
 *     payloads on this surface are raw by design and a transcript that quietly
 *     rewrote a tool's output would be worse than one carrying a value.
 */
import { describe, expect, it } from "vitest";
import {
  createSecretScrubber,
  MIN_SCRUBBABLE_LENGTH,
} from "../secret-scrubber";

const STRIPE = { name: "STRIPE_API_KEY", value: "sk_live_51H8xQ2abcdef" };
const GH = { name: "GH_TOKEN", value: "ghp_0123456789abcdef" };

describe("createSecretScrubber", () => {
  it("returns null when there is nothing worth scrubbing", () => {
    // `null`, not a no-op object: the call sites read `scrubber ? … : x`, so the
    // common no-secrets path does no work and is visible as doing none.
    expect(createSecretScrubber([])).toBeNull();
    expect(
      createSecretScrubber([{ name: "PIN", value: "1234" }]),
      "a value under the length floor must not be registered",
    ).toBeNull();
  });

  it("does not register a short value, because the collateral is worse", () => {
    // Replacing every occurrence of a 4-character value would corrupt unrelated
    // text throughout the transcript.
    const short = "a".repeat(MIN_SCRUBBABLE_LENGTH - 1);
    const long = "b".repeat(MIN_SCRUBBABLE_LENGTH);
    const scrubber = createSecretScrubber([
      { name: "SHORT", value: short },
      { name: "LONG", value: long },
    ]);
    expect(scrubber?.size).toBe(1);
    expect(scrubber!.scrubString(`${short} ${long}`)).toBe(
      `${short} [secret:LONG]`,
    );
  });
});

describe("scrubString", () => {
  it("replaces every occurrence, not just the first", () => {
    const scrubber = createSecretScrubber([STRIPE])!;
    expect(
      scrubber.scrubString(
        `export A=${STRIPE.value}\nexport B=${STRIPE.value}`,
      ),
    ).toBe(
      "export A=[secret:STRIPE_API_KEY]\nexport B=[secret:STRIPE_API_KEY]",
    );
  });

  it("finds the value inside a JSON-serialized string too", () => {
    // A tool that returns its own config as a JSON string, or any payload
    // scrubbed after `JSON.stringify`. A value carrying a quote or a newline
    // looks nothing like itself once escaped.
    const awkward = { name: "PEM_KEY", value: '-----BEGIN\n"key"\\here-----' };
    const scrubber = createSecretScrubber([awkward])!;
    const serialized = JSON.stringify({ env: { PEM_KEY: awkward.value } });
    expect(serialized).toContain("\\n");
    const scrubbed = scrubber.scrubString(serialized);
    expect(scrubbed).not.toContain("BEGIN");
    expect(JSON.parse(scrubbed)).toEqual({
      env: { PEM_KEY: "[secret:PEM_KEY]" },
    });
  });

  it("leaves unregistered text byte-identical", () => {
    const scrubber = createSecretScrubber([STRIPE])!;
    const untouched =
      "sk_live_somethingelse and $& and ${} and [secret:NOT_REAL]";
    expect(scrubber.scrubString(untouched)).toBe(untouched);
  });

  it("does not let a value containing $& corrupt the replacement", () => {
    // `String.replace` with a string pattern expands `$&` in the replacement.
    // A credential that happens to contain it would be re-expanded back into
    // the output — which is why this uses split/join.
    const tricky = { name: "WEIRD", value: "abc$&def$1ghi" };
    const scrubber = createSecretScrubber([tricky])!;
    expect(scrubber.scrubString(`v=${tricky.value}`)).toBe("v=[secret:WEIRD]");
  });

  it("replaces the LONGER of two overlapping secrets first", () => {
    // Otherwise the shorter replacement runs first and leaves the longer value
    // partially intact in the transcript.
    const inner = { name: "INNER", value: "0123456789abcdef" };
    const outer = { name: "OUTER", value: "Bearer 0123456789abcdef" };
    const scrubber = createSecretScrubber([inner, outer])!;
    expect(scrubber.scrubString(`auth: ${outer.value}`)).toBe(
      "auth: [secret:OUTER]",
    );
    expect(scrubber.scrubString(`raw: ${inner.value}`)).toBe(
      "raw: [secret:INNER]",
    );
  });
});

describe("scrubDeep", () => {
  it("reaches string leaves at any depth, in objects and arrays alike", () => {
    const scrubber = createSecretScrubber([STRIPE, GH])!;
    const payload = {
      toolName: "bash",
      output: {
        stdout: [`STRIPE_API_KEY=${STRIPE.value}`, "PATH=/usr/bin"],
        nested: { deep: { token: GH.value } },
      },
      count: 2,
      ok: true,
      nothing: null,
    };
    expect(scrubber.scrubDeep(payload)).toEqual({
      toolName: "bash",
      output: {
        stdout: ["STRIPE_API_KEY=[secret:STRIPE_API_KEY]", "PATH=/usr/bin"],
        nested: { deep: { token: "[secret:GH_TOKEN]" } },
      },
      count: 2,
      ok: true,
      nothing: null,
    });
  });

  it("rewrites a credential that appears as an object KEY", () => {
    // The producers are third-party MCP servers, so "no payload puts a secret
    // in key position" is not a property this process can assert. A tool that
    // groups by API key or echoes a header map does exactly that, and an
    // unscrubbed key reaches the transcript in plaintext.
    const scrubber = createSecretScrubber([STRIPE])!;
    const out = scrubber.scrubDeep({ [STRIPE.value]: "value" }) as Record<
      string,
      string
    >;
    expect(Object.keys(out)).toEqual(["[secret:STRIPE_API_KEY]"]);
    expect(JSON.stringify(out)).not.toContain(STRIPE.value);
  });

  it("leaves ordinary keys byte-identical", () => {
    // Scrubbing keys must not reshape a payload that holds no credential —
    // otherwise every caller downstream loses the fields it addresses by name.
    const scrubber = createSecretScrubber([STRIPE])!;
    const input = { id: "1", nested: { "weird key": [1, 2] }, "": "empty" };
    expect(scrubber.scrubDeep(input)).toEqual(input);
  });

  it("keeps an own __proto__ key instead of feeding it to the setter", () => {
    // Legal JSON, and a third-party server can emit it. Plain assignment would
    // hand it to the prototype setter: the field disappears and the result
    // stops being a plain object, which the traversal guard then skips whole.
    const scrubber = createSecretScrubber([STRIPE])!;
    const input = JSON.parse(
      `{"__proto__": {"leak": "${STRIPE.value}"}, "keep": "ok"}`,
    );
    const out = scrubber.scrubDeep(input) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(true);
    expect(out.keep).toBe("ok");
    // And the value nested under it is still scrubbed.
    expect(JSON.stringify(out)).not.toContain(STRIPE.value);
  });

  it("passes non-plain objects through by identity", () => {
    // Rebuilding a Date or a typed array as a plain object would corrupt the
    // payload far more than a missed scrub would.
    const scrubber = createSecretScrubber([STRIPE])!;
    const date = new Date(0);
    const bytes = new Uint8Array([1, 2, 3]);
    const out = scrubber.scrubDeep({ date, bytes });
    expect(out.date).toBe(date);
    expect(out.bytes).toBe(bytes);
  });

  it("leaves a payload with no registered value structurally identical", () => {
    const scrubber = createSecretScrubber([STRIPE])!;
    const payload = { a: ["x", { b: "y" }], n: 1 };
    expect(scrubber.scrubDeep(payload)).toEqual(payload);
  });
});
