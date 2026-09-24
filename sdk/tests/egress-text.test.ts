import { describe, expect, it } from "vitest";
import {
  createEgressRedactor,
  scrubModelOutputText,
} from "../src/contract/egress-text.js";

// The redactor is a byte-identical mirror of the hosted one (pinned on the
// backend as `analysis-egress-text`); the shared v5 judge fixture proves the
// two produce the same request. These pin the behaviour a local caller sees.
describe("egress redactor (local mirror)", () => {
  it("maps values to consistent placeholders within one redactor", () => {
    const redactor = createEgressRedactor();
    expect(redactor.string("a@x.io, b@y.io, again A@X.io")).toBe(
      "[email-a], [email-b], again [email-a]"
    );
    expect(redactor.string("call 415-555-0123")).toBe("call [phone-a]");
  });

  it("files a Luhn-invalid 16-digit run as an id, never a card", () => {
    const redactor = createEgressRedactor();
    expect(redactor.string("4111 1111 1111 1111 / 4111111111111112")).toBe(
      "[card-a] / [id-a]"
    );
  });

  it("files a Luhn-valid timestamp as an id: no card network issues from 1", () => {
    const redactor = createEgressRedactor();
    expect(redactor.string('{"createdAt":1758700000005}')).toBe(
      '{"createdAt":[id-a]}'
    );
  });

  it("never reissues a placeholder already in the input", () => {
    expect(
      createEgressRedactor().text({ old: "[email-a]", raw: "c@z.io" })
    ).toBe('{"old":"[email-a]","raw":"[email-b]"}');
  });

  it("keeps structure and replaces credential-named fields whole", () => {
    expect(
      createEgressRedactor().deep({ apiKey: { x: 1 }, to: "a@x.io", n: 2 })
    ).toEqual({ apiKey: "[REDACTED]", to: "[email-a]", n: 2 });
  });

  it("scrubs model output without rejecting it", () => {
    expect(scrubModelOutputText("Ask dan@q.com.")).toBe("Ask [email-a].");
  });
});
