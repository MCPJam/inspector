/**
 * Planning a `{{secret:NAME}}` act.
 *
 * Every refusal here has the same failure behind it: a literal
 * `{{secret:NAME}}` typed into a real field on a real site, which the model
 * then cannot tell from a password that did not work. And every message has
 * the same rule: it names the NAME and never the value, because the whole
 * point is that the model never learns one.
 */
import { describe, expect, it } from "vitest";
import {
  hasSecretPlaceholder,
  planSecretPlaceholders,
  secretNamesIn,
  substituteSecrets,
} from "../secret-placeholders";

const available = [
  { name: "GITHUB_PASSWORD", value: "hunter2-hunter2" },
  { name: "API_TOKEN", value: "tok-abcdefghij" },
];

describe("secretNamesIn", () => {
  it("finds a placeholder, and each name once", () => {
    expect(secretNamesIn("{{secret:A_B}} and {{secret:A_B}}")).toEqual(["A_B"]);
  });

  it("finds several, in order", () => {
    expect(secretNamesIn("{{secret:FIRST}}/{{secret:SECOND}}")).toEqual([
      "FIRST",
      "SECOND",
    ]);
  });

  it("holds to the backend's own name charset", () => {
    // Lowercase, leading digits and hyphens are not secret names, so a string
    // that merely looks like one is ordinary text.
    for (const text of [
      "{{secret:lower}}",
      "{{secret:1LEADING}}",
      "{{secret:HAS-HYPHEN}}",
      "{{ secret:SPACED }}",
      "{secret:SINGLE}",
    ]) {
      expect(secretNamesIn(text), text).toEqual([]);
    }
  });

  it("reads one out of a longer string", () => {
    expect(secretNamesIn("user-{{secret:SUFFIX}}@example.com")).toEqual([
      "SUFFIX",
    ]);
  });

  it("is not confused by a previous call", () => {
    // The pattern carries `g`; a shared instance's `lastIndex` survives between
    // calls and silently skips the first match of every other string.
    expect(hasSecretPlaceholder("{{secret:A}}")).toBe(true);
    expect(hasSecretPlaceholder("{{secret:A}}")).toBe(true);
  });
});

describe("substituteSecrets", () => {
  it("substitutes EVERY occurrence inside a longer string", () => {
    // A `type` by ref REPLACES the whole field, so a prefix and a secret
    // cannot be composed out of two separate acts — embedded has to work.
    expect(
      substituteSecrets(
        "user-{{secret:S}}:{{secret:S}}",
        new Map([["S", "xyz"]]),
      ),
    ).toBe("user-xyz:xyz");
  });

  it("refuses rather than leaving a placeholder in the text", () => {
    // The one outcome this whole module exists to prevent.
    expect(substituteSecrets("{{secret:MISSING}}", new Map())).toBeNull();
  });

  it("refuses when only SOME names resolve", () => {
    expect(
      substituteSecrets(
        "{{secret:KNOWN}}{{secret:MISSING}}",
        new Map([["KNOWN", "v"]]),
      ),
    ).toBeNull();
  });

  it("leaves text with no placeholder exactly as it was", () => {
    expect(substituteSecrets("plain text", new Map())).toBe("plain text");
  });

  it("documents the no-escape limitation", () => {
    // There is NO WAY to type a literal `{{secret:X}}` into a page. An escape
    // syntax is a second thing to get right in a security-relevant parser, to
    // serve a case nobody has — so a model that wants that string gets its
    // value substituted, or a refusal if there is none.
    expect(substituteSecrets("{{secret:S}}", new Map([["S", "v"]]))).toBe("v");
    expect(substituteSecrets("{{secret:S}}", new Map())).toBeNull();
  });
});

describe("planSecretPlaceholders", () => {
  it("plans nothing for an act with no placeholder", () => {
    expect(
      planSecretPlaceholders({ verb: "type", value: "hello", available }),
    ).toEqual({ deliver: [] });
  });

  it("delivers ONLY the names the act references", () => {
    // Sending the whole set would put values on the wire the command has no
    // use for — and the daemon registers what it is sent, so it would start
    // scrubbing observations for credentials nobody typed.
    expect(
      planSecretPlaceholders({
        verb: "type",
        value: "{{secret:API_TOKEN}}",
        available,
      }),
    ).toEqual({ deliver: [{ name: "API_TOKEN", value: "tok-abcdefghij" }] });
  });

  it("reads fields as well as value, for fill_form", () => {
    const plan = planSecretPlaceholders({
      verb: "fill_form",
      fields: [
        { value: "alex" },
        { value: "{{secret:GITHUB_PASSWORD}}" },
      ],
      available,
    });
    expect(plan.deliver.map((s) => s.name)).toEqual(["GITHUB_PASSWORD"]);
  });

  it("refuses an unknown name and NEVER echoes a value", () => {
    const plan = planSecretPlaceholders({
      verb: "type",
      value: "{{secret:NOPE}}",
      available,
    });
    expect(plan.refusal?.code).toBe("secret_unknown");
    expect(plan.refusal?.message).toContain("NOPE");
    expect(plan.deliver).toEqual([]);
    for (const secret of available) {
      expect(plan.refusal?.message).not.toContain(secret.value);
    }
  });

  it("refuses a BROKERED secret by name, with the reason", () => {
    // Its own code because the fix is different: a brokered value never enters
    // this process, so the user has to switch it to materialized delivery —
    // a decision with consequences, not a typo in a name.
    const plan = planSecretPlaceholders({
      verb: "type",
      value: "{{secret:EGRESS_KEY}}",
      available,
      brokered: ["EGRESS_KEY"],
    });
    expect(plan.refusal?.code).toBe("secret_not_typeable");
    expect(plan.refusal?.message).toContain("EGRESS_KEY");
    expect(plan.refusal?.message).toContain("materialized");
  });

  it("refuses a placeholder on a verb that types nothing", () => {
    // `press {{secret:X}}` is asking for a KEY NAME, and substituting a
    // password there would send several hundred unknown keystrokes.
    for (const verb of ["click", "press", "scroll", "select", "hover"]) {
      const plan = planSecretPlaceholders({
        verb,
        value: "{{secret:API_TOKEN}}",
        available,
      });
      expect(plan.refusal?.code, verb).toBe("secret_verb_refused");
      expect(plan.refusal?.message).toContain(verb);
    }
  });

  it("allows a placeholder on the two typing verbs", () => {
    for (const verb of ["type", "fill_form"]) {
      expect(
        planSecretPlaceholders({
          verb,
          value: "{{secret:API_TOKEN}}",
          available,
        }).refusal,
        verb,
      ).toBeUndefined();
    }
  });

  it("refuses every name when the turn has no secrets at all", () => {
    // The public `/v1` callers' position: no registry, so every placeholder is
    // unknown rather than silently typed.
    expect(
      planSecretPlaceholders({
        verb: "type",
        value: "{{secret:ANY}}",
        available: [],
      }).refusal?.code,
    ).toBe("secret_unknown");
  });

  it("reports the FIRST problem when there are several", () => {
    const plan = planSecretPlaceholders({
      verb: "type",
      value: "{{secret:FIRST_BAD}}{{secret:SECOND_BAD}}",
      available,
    });
    expect(plan.refusal?.message).toContain("FIRST_BAD");
    expect(plan.refusal?.message).not.toContain("SECOND_BAD");
  });
  it("refuses a secret too SHORT to scrub, by name, never its value or length", () => {
    // An echo of a PIN in page text could not be scrubbed, so it is never typed.
    const plan = planSecretPlaceholders({
      verb: "type",
      value: "{{secret:PIN}}",
      available: [...available, { name: "PIN", value: "4921" }],
    });
    expect(plan.deliver).toEqual([]);
    expect(plan.refusal?.code).toBe("secret_too_short");
    expect(plan.refusal?.message).toContain('"PIN"');
    expect(plan.refusal?.message).toContain("8 characters");
    expect(plan.refusal?.message).not.toContain("4921");
    expect(plan.refusal?.message).not.toMatch(/\b4\b/);
  });

  it("reports an unknown name before a short one", () => {
    const plan = planSecretPlaceholders({
      verb: "type",
      value: "{{secret:PIN}}{{secret:NOPE}}",
      available: [{ name: "PIN", value: "4921" }],
    });
    expect(plan.refusal?.code).toBe("secret_unknown");
  });
});
