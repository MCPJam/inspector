import { describe, expect, it } from "vitest";
import {
  isDocumentFrame,
  isInjectedScriptException,
  isInjectedScriptStack,
} from "../injected-script-frames";

const ORIGIN = "https://app.mcpjam.com";

describe("isDocumentFrame", () => {
  // What PostHog recorded on 2026-09-23. Absolute and route-relative both
  // appear, and the route differs from the one the user was on when it threw.
  it.each([
    ["an absolute document URL", `${ORIGIN}/p/v97d1szz/playground`],
    ["a route-relative one", "/p/v97d1szz/tasks"],
    ["one carrying a query", `${ORIGIN}/p/v97d1szz/playground?conversation=x`],
  ])("reads %s as the document", (_label, filename) => {
    expect(isDocumentFrame(filename, ORIGIN)).toBe(true);
  });

  it.each([
    ["our own bundle", `${ORIGIN}/assets/index-Ct2CwjTH.js`],
    ["a Vite dev module", "/src/main.tsx?t=1730"],
    ["Cloudflare's same-origin script", `${ORIGIN}/cdn-cgi/scripts/main.js`],
    // The reason this is not an extension test: seat-payment-stripe.ts loads
    // this exact URL, and an extension rule swallowed every Stripe failure.
    ["extensionless Stripe.js", "https://js.stripe.com/v3/"],
    ["another origin entirely", "https://cdn.example.com/widget"],
    ["an engine-synthesised frame", "<anonymous>"],
    ["a native frame", "[native code]"],
    ["a non-string", undefined],
  ])("does not read %s as the document", (_label, filename) => {
    expect(isDocumentFrame(filename, ORIGIN)).toBe(false);
  });

  // The packaged desktop app has an opaque origin, so nothing resolves and
  // nothing is dropped. It has no page translation to guard against anyway.
  it("drops nothing when the origin is opaque", () => {
    expect(isDocumentFrame("/p/v97d1szz/tasks", "null")).toBe(false);
  });
});

describe("isInjectedScriptStack", () => {
  it("matches a stack stamped entirely with document routes", () => {
    const filenames = [
      `${ORIGIN}/p/v97d1szz/playground`,
      `${ORIGIN}/p/v97d1szz/tasks`,
      `${ORIGIN}/p/v97d1szz/tasks`,
    ];
    expect(isInjectedScriptStack(filenames, ORIGIN)).toBe(true);
  });

  // A real overflow in our markdown lexer looks like this, and must report.
  it("spares a stack with one frame from a script we loaded", () => {
    const filenames = [
      `${ORIGIN}/assets/index-Ct2CwjTH.js`,
      `${ORIGIN}/p/v97d1szz/playground`,
    ];
    expect(isInjectedScriptStack(filenames, ORIGIN)).toBe(false);
  });

  it("spares an empty stack, which attributes to nobody", () => {
    expect(isInjectedScriptStack([], ORIGIN)).toBe(false);
  });
});

describe("isInjectedScriptException", () => {
  const injected = [`${ORIGIN}/p/v97d1szz/playground`];

  it("matches when every value is stamped entirely with the document", () => {
    expect(isInjectedScriptException([injected, injected], ORIGIN)).toBe(true);
  });

  // A string `cause` arrives with no frames. Pooled with the other value's
  // frames it would vanish, and the event would drop.
  it("spares a chain where one value has no frames", () => {
    expect(isInjectedScriptException([injected, []], ORIGIN)).toBe(false);
  });

  it("spares an event with no exception values", () => {
    expect(isInjectedScriptException([], ORIGIN)).toBe(false);
  });
});
