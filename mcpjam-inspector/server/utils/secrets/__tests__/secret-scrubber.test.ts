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
  escapeDepthOf,
  literalAnchorOf,
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
      "a value under the length floor must not be registered"
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
      `${short} [secret:LONG]`
    );
  });
});

describe("scrubString", () => {
  it("replaces every occurrence, not just the first", () => {
    const scrubber = createSecretScrubber([STRIPE])!;
    expect(
      scrubber.scrubString(`export A=${STRIPE.value}\nexport B=${STRIPE.value}`)
    ).toBe(
      "export A=[secret:STRIPE_API_KEY]\nexport B=[secret:STRIPE_API_KEY]"
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
      "auth: [secret:OUTER]"
    );
    expect(scrubber.scrubString(`raw: ${inner.value}`)).toBe(
      "raw: [secret:INNER]"
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
      `{"__proto__": {"leak": "${STRIPE.value}"}, "keep": "ok"}`
    );
    const out = scrubber.scrubDeep(input) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(true);
    expect(out.keep).toBe("ok");
    // And the value nested under it is still scrubbed.
    expect(JSON.stringify(out)).not.toContain(STRIPE.value);
  });

  it("does not corrupt serialized JSON by matching its punctuation", () => {
    // The raw form of a value must not be searched inside an already-serialized
    // document. Real string content is escaped there, so the raw form can only
    // match by coincidence — including against the document's own structure.
    // This value never appears in the payload; it matches the braces around it.
    const structural = { name: "ODD", value: '","foo":' };
    const scrubber = createSecretScrubber([structural])!;
    const body = JSON.stringify({ a: "", foo: "x" });

    const scrubbed = scrubber.scrubSerializedJson(body);
    expect(() => JSON.parse(scrubbed)).not.toThrow();
    expect(JSON.parse(scrubbed)).toEqual({ a: "", foo: "x" });
  });

  it("preserves envelope keys that happen to equal a secret value", () => {
    // Control metadata is part of the persisted contract. A global textual
    // replacement would turn the required `chatSessionId` field into a marker
    // when a credential's value happened to be that same string.
    const scrubber = createSecretScrubber([
      { name: "ODD_KEY", value: "chatSessionId" },
    ])!;
    const body = JSON.stringify({
      chatSessionId: "chatSessionId",
      payload: { echoed: "chatSessionId" },
    });

    const scrubbed = JSON.parse(scrubber.scrubSerializedJson(body));
    expect(scrubbed).toEqual({
      chatSessionId: "[secret:ODD_KEY]",
      payload: { echoed: "[secret:ODD_KEY]" },
    });
    expect(
      Object.prototype.hasOwnProperty.call(scrubbed, "chatSessionId")
    ).toBe(true);
  });

  it("still redacts a real value inside serialized JSON", () => {
    // The guard on the guard: refusing the raw form must not stop it finding
    // the value where it genuinely occurs, in escaped form.
    const scrubber = createSecretScrubber([STRIPE])!;
    const body = JSON.stringify({ note: `key is ${STRIPE.value} ok` });

    const scrubbed = scrubber.scrubSerializedJson(body);
    expect(scrubbed).not.toContain(STRIPE.value);
    expect(JSON.parse(scrubbed).note).toBe("key is [secret:STRIPE_API_KEY] ok");
  });

  it("finds a value whose escaped form differs, inside serialized JSON", () => {
    // A newline-bearing credential looks nothing like itself once serialized.
    const pem = { name: "PEM_KEY", value: "-----BEGIN-----\nabc\n" };
    const scrubber = createSecretScrubber([pem])!;
    const body = JSON.stringify({ blob: pem.value });

    const scrubbed = scrubber.scrubSerializedJson(body);
    expect(JSON.parse(scrubbed).blob).toBe("[secret:PEM_KEY]");
  });

  it("scrubs a credential nested inside a JSON-STRING tool result", () => {
    // The double-escape case, and the reason needles are generated per depth.
    //
    // A tool that returns its config as a JSON string already holds the value
    // in escaped form; serializing the surrounding ingest body escapes it a
    // second time. The once-escaped needle does not appear in that text at all,
    // so a quote-bearing credential used to survive here and surface intact the
    // moment the outer document was parsed.
    const quoted = { name: "ODD_KEY", value: 'abcdefgh"i' };
    const scrubber = createSecretScrubber([quoted])!;

    // What a tool returning JSON-as-a-string actually produces.
    const toolResult = JSON.stringify({ apiKey: quoted.value });
    const body = JSON.stringify({ output: toolResult });
    // Precondition: the value really is doubly escaped in these bytes, so the
    // test is exercising the case it claims to.
    expect(body).toContain('abcdefgh\\\\\\"i');

    const scrubbed = scrubber.scrubSerializedJson(body);
    // Parsed back out at BOTH levels — the credential must not be recoverable
    // from the transcript by anyone who simply parses what we stored.
    const inner = JSON.parse(JSON.parse(scrubbed).output);
    expect(inner.apiKey).toBe("[secret:ODD_KEY]");
    expect(scrubbed).not.toContain("abcdefgh");
  });

  it("reads escape depth off the payload's escaping, not off its size", () => {
    // The bound that keeps scrub work proportional to the escaping a payload
    // actually carries. Asserted directly because it is otherwise visible only
    // as a timing difference — and it has already been undone once by an edit
    // that every correctness test still passed.
    const megabyteOfProse = "lorem ipsum dolor sit amet. ".repeat(40_000);
    expect(megabyteOfProse.length).toBeGreaterThan(1_000_000);
    expect(escapeDepthOf(megabyteOfProse)).toBe(1);

    // Depth d costs a run of 2^d - 1 backslashes for a quote-bearing value
    // (1, 3, 7, 15 …) and 2^(d-1) for a newline-bearing one (1, 2, 4, 8 …).
    // The bound has to assume the CHEAPER of the two, or it would under-count
    // the depth a newline-bearing value can reach — so it must rise with the
    // run and stay at or above the depth that run proves, which for the
    // quote-bearing value below leaves slack rather than cutting close.
    expect(escapeDepthOf("no backslashes here")).toBe(1);
    expect(escapeDepthOf("a\\b")).toBe(2);
    let carrier: string = 'abcdefgh"i';
    for (let depth = 1; depth <= 8; depth++) {
      carrier = JSON.stringify({ v: carrier });
      expect(escapeDepthOf(carrier)).toBeGreaterThanOrEqual(depth);
    }
  });

  it("scrubs a credential whose escaped form outgrows any fixed byte cutoff", () => {
    // The second cliff, in the guard added to close the first one. Forms double
    // in length, so a fixed byte cutoff is a depth cutoff wearing a disguise: a
    // 64 KiB cap stopped at depth 16, and a body nested 17 deep — 640 KiB, well
    // under what the ingest path will persist — contained only the depth-17
    // form. None of the fifteen generated needles matched it, and the
    // credential came back out by decoding the layers.
    //
    // The bound has to be the haystack, which cannot be outgrown by definition.
    const quoted = { name: "ODD_KEY", value: 'abcdefgh"i' };
    const scrubber = createSecretScrubber([quoted])!;

    let carrier: string = quoted.value;
    for (let i = 0; i < 17; i++) carrier = JSON.stringify({ v: carrier });
    // Precondition: big enough that a byte cutoff bites, and really 17 deep.
    expect(carrier.length).toBeGreaterThan(600_000);

    const scrubbed = scrubber.scrubSerializedJson(carrier);
    expect(scrubbed).not.toContain("abcdefgh");

    let decoded: unknown = JSON.parse(scrubbed);
    for (let i = 1; i < 17; i++) {
      decoded = JSON.parse((decoded as { v: string }).v);
    }
    expect((decoded as { v: string }).v).toBe("[secret:ODD_KEY]");
  });

  it("generates nothing for a payload that cannot contain the secret", () => {
    // The depth bound alone is not enough. One pathological run of backslashes
    // reports a deep escaping, and every registered secret would then be dragged
    // out to twenty-odd exponentially growing forms — for a payload that plainly
    // contains none of them. Measured at 1 MiB of solid backslashes, that was
    // ~100 MiB of needles across 50 secrets, none of which could ever match.
    //
    // The precondition is exact rather than a heuristic: escaping never rewrites
    // a value's ordinary characters, so its longest such run appears verbatim in
    // every form at every depth.
    const quoted = { name: "ODD_KEY", value: 'abcdefgh"i' };
    expect(literalAnchorOf(quoted.value)).toBe("abcdefgh");

    const scrubber = createSecretScrubber([quoted])!;
    const solidBackslashes = "\\".repeat(200_000);
    // Precondition: this really does report a deep escaping.
    expect(escapeDepthOf(solidBackslashes)).toBeGreaterThan(15);

    // The gate is the point: without it this input's reported depth would build
    // twenty exponentially growing forms for a secret it cannot contain.
    expect(scrubber.needleCountFor(solidBackslashes)).toBe(0);
    expect(scrubber.scrubString(solidBackslashes)).toBe(solidBackslashes);
    // And the anchor being present still finds the value, so the gate is a
    // precondition and not a second cliff.
    const withSecret = `${solidBackslashes}${quoted.value}`;
    expect(scrubber.needleCountFor(withSecret)).toBeGreaterThan(0);
    expect(scrubber.scrubString(withSecret)).toContain("[secret:ODD_KEY]");
  });

  it("has no anchor for a value made only of escapable characters", () => {
    // Then there is nothing to test against and generation proceeds as before,
    // rather than the empty anchor matching everything or nothing by accident.
    expect(literalAnchorOf('"\\\n"')).toBe("");
    const oddball = { name: "WEIRD", value: '"""\\\\""""' };
    const scrubber = createSecretScrubber([oddball])!;
    expect(scrubber.scrubString(`x${oddball.value}y`)).toBe("x[secret:WEIRD]y");
  });

  it("leaves a large UNESCAPED payload untouched, and cheaply", () => {
    // The depth bound is read off the input's own longest backslash run, not
    // off its size. Prose carrying no escaping at all resolves to depth 1 no
    // matter how large it is, so a megabyte of tool output does not drag every
    // registered secret out to twenty-odd escaped forms.
    //
    // This asserts the CORRECTNESS half of that (the payload survives intact);
    // the cost half is not something a unit test can pin without becoming a
    // timing flake, so it lives in the comment on the bound itself.
    const quoted = { name: "ODD_KEY", value: 'abcdefgh"i' };
    const scrubber = createSecretScrubber([quoted])!;
    const prose = "lorem ipsum dolor sit amet. ".repeat(40_000);

    // Unescaped prose is depth 1 however large, so one needle per secret.
    expect(scrubber.needleCountFor(prose)).toBe(0); // anchor absent
    expect(scrubber.needleCountFor(`${prose}${quoted.value}`)).toBe(2);
    expect(scrubber.scrubString(prose)).toBe(prose);
    // Still finds a genuine occurrence in a payload of that size.
    expect(scrubber.scrubString(`${prose}${quoted.value}`)).toBe(
      `${prose}[secret:ODD_KEY]`,
    );
  });

  it("terminates on a payload that is mostly backslashes", () => {
    // The pathological input for a run-derived bound: a long backslash run
    // implies a deep escaping that nothing here is actually carrying. The
    // ceiling and the form-length guard have to stop it rather than building
    // forms that double all the way up.
    const quoted = { name: "ODD_KEY", value: 'abcdefgh"i' };
    const scrubber = createSecretScrubber([quoted])!;
    const slashes = "\\".repeat(100_000);

    expect(scrubber.scrubString(slashes)).toBe(slashes);
    expect(scrubber.scrubString(`${slashes}${quoted.value}`)).toContain(
      "[secret:ODD_KEY]",
    );
  });

  it("scrubs a credential nested past any fixed escape depth", () => {
    // The depth-3 cap was a cliff, not a limit. Each escaped form is a distinct
    // string that contains none of the shallower ones — re-escaping DOUBLES the
    // backslash run in front of the quote, so the depth-3 needle does not line
    // up inside the depth-4 form. A credential wrapped one level past the cap
    // therefore survived whole and came back out the moment a consumer decoded
    // the nesting.
    //
    // Driven over a RANGE rather than at depth 4 alone: a test pinned to the
    // first depth past the old cap would pass again for any new constant, which
    // is the bug rather than a fix.
    const quoted = { name: "ODD_KEY", value: 'abcdefgh"i' };
    const scrubber = createSecretScrubber([quoted])!;

    for (let depth = 1; depth <= 6; depth++) {
      // `depth` rounds of serialization, exactly what a chain of tools each
      // returning the previous one's JSON as a string produces.
      let carrier: string = quoted.value;
      for (let i = 0; i < depth; i++) carrier = JSON.stringify({ v: carrier });

      // Precondition: this really is escaped `depth` times over, so the case
      // being claimed is the case being run.
      const runOfBackslashes = "\\".repeat(2 ** depth - 1);
      expect(carrier).toContain(`abcdefgh${runOfBackslashes}"i`);

      const scrubbed = scrubber.scrubSerializedJson(carrier);

      // Decoded back through every level: the credential must not be
      // recoverable from what we persisted.
      let decoded: unknown = JSON.parse(scrubbed);
      for (let i = 1; i < depth; i++) {
        decoded = JSON.parse((decoded as { v: string }).v);
      }
      expect((decoded as { v: string }).v).toBe("[secret:ODD_KEY]");
      expect(scrubbed).not.toContain("abcdefgh");
    }
  });

  it("scrubs backslash- and newline-bearing values at nesting depth two", () => {
    const pem = { name: "PEM_KEY", value: "-----BEGIN-----\nab\\c\n" };
    const scrubber = createSecretScrubber([pem])!;
    const body = JSON.stringify({
      output: JSON.stringify({ blob: pem.value }),
    });

    const scrubbed = scrubber.scrubSerializedJson(body);
    expect(JSON.parse(JSON.parse(scrubbed).output).blob).toBe(
      "[secret:PEM_KEY]"
    );
    expect(scrubbed).not.toContain("BEGIN");
  });

  it("still scrubs an ordinary value at depth one after the depth change", () => {
    // The guard on the guard: generating deeper forms must not stop the
    // single-level case, which is the overwhelmingly common one.
    const scrubber = createSecretScrubber([STRIPE])!;
    const body = JSON.stringify({ key: STRIPE.value });
    expect(JSON.parse(scrubber.scrubSerializedJson(body)).key).toBe(
      `[secret:${STRIPE.name}]`
    );
  });

  it("never hands back UNSCRUBBED content at a cycle back-reference", () => {
    // The guard that stops the recursion must not splice the original object
    // into the result: a back-reference sits below the depth cap, so returning
    // it verbatim reinserts a subtree the scrubber never touched. Whatever the
    // caller does next — serialize, truncate, scrub again — a credential that
    // got back in this way can survive, because a value cut mid-way matches no
    // needle.
    const cyclic: Record<string, unknown> = { key: STRIPE.value };
    cyclic.self = cyclic;
    const out = createSecretScrubber([STRIPE])!.scrubDeep(cyclic);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(STRIPE.value);
    // And the result is acyclic, so a later pass cannot rediscover the cycle.
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("never hands back UNSCRUBBED content past the depth cap", () => {
    let deep: Record<string, unknown> = { key: STRIPE.value };
    for (let i = 0; i < 50; i++) deep = { nested: deep };
    const out = createSecretScrubber([STRIPE])!.scrubDeep(deep);
    expect(JSON.stringify(out)).not.toContain(STRIPE.value);
  });

  it("caps a deeply nested OBJECT at the depth frontier", () => {
    // Note what this does and does not show. The leaves here sit 30 levels
    // down, well past the cap, so they are never reached — the object above
    // them becomes the marker and takes them with it. That is the correct
    // behaviour and worth pinning, but it is a test of the FRONTIER, not of
    // the primitive exemption; the leaves could be anything.
    //
    // The exemption itself is the test below, where the primitives sit at the
    // boundary and are actually visited. Keeping the two apart matters: the
    // mutation that broke the exemption failed only that one, which is the
    // tell that this test never exercised it.
    let deep: Record<string, unknown> = {
      n: 42,
      b: true,
      nil: null,
      s: "plain text",
    };
    for (let i = 0; i < 30; i++) deep = { nested: deep };
    const out = createSecretScrubber([STRIPE])!.scrubDeep(deep) as Record<
      string,
      unknown
    >;
    // Walk to the capped frontier and confirm what sits there is the marker
    // for the OBJECT, never a rewritten primitive.
    let cursor: unknown = out;
    let hops = 0;
    while (
      cursor &&
      typeof cursor === "object" &&
      "nested" in (cursor as Record<string, unknown>)
    ) {
      cursor = (cursor as Record<string, unknown>).nested;
      hops += 1;
    }
    expect(hops).toBeGreaterThan(0);
    expect(cursor).toBe("[truncated: max depth]");
  });

  it("preserves a PRIMITIVE at the cap boundary instead of marking it", () => {
    // The exemption, exercised: these leaves are shallow enough to be visited,
    // so the guard ordering in `scrubDeepInner` is what decides their fate. A
    // leaf is not a descent — a number, boolean or null cannot recurse and
    // cannot hide a credential — so capping one would replace real tool data
    // with the marker string, changing both the value and its type.
    let deep: Record<string, unknown> = { n: 7, b: false, nil: null };
    for (let i = 0; i < 7; i++) deep = { nested: deep };
    const serialized = JSON.stringify(
      createSecretScrubber([STRIPE])!.scrubDeep(deep)
    );
    expect(serialized).toContain('"n":7');
    expect(serialized).toContain('"b":false');
    expect(serialized).toContain('"nil":null');
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
