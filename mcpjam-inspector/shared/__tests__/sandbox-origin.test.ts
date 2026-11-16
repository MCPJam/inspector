import { describe, expect, it } from "vitest";
import { sandboxOriginOf } from "../sandbox-origin";

describe("sandboxOriginOf", () => {
  it("keeps the origin of an http(s) URL and nothing else", () => {
    expect(sandboxOriginOf("https://sandbox.example.com")).toBe(
      "https://sandbox.example.com",
    );
    expect(sandboxOriginOf(" https://Sandbox.Example.com:443/path?q#h ")).toBe(
      "https://sandbox.example.com",
    );
    expect(sandboxOriginOf("http://sandbox.internal:8080")).toBe(
      "http://sandbox.internal:8080",
    );
  });

  it.each([
    undefined,
    null,
    42,
    "",
    "   ",
    "sandbox.example.com",
    "ftp://x.example",
    "javascript:alert(1)",
    "data:text/html,x",
  ])("is null for %s", (raw) => {
    expect(sandboxOriginOf(raw)).toBeNull();
  });
});
