import { describe, expect, it } from "vitest";
import {
  isSafeExternalLinkUrl,
  filterSafeExternalLinkUrls,
} from "../safe-external-url";

describe("isSafeExternalLinkUrl", () => {
  it("accepts absolute https URLs", () => {
    expect(isSafeExternalLinkUrl("https://github.com/login/device")).toBe(true);
    expect(
      isSafeExternalLinkUrl("https://accounts.google.com/o/oauth2/v2/auth?x=1")
    ).toBe(true);
  });

  it("rejects all plain http, including localhost (points at the user's machine, not the sandbox)", () => {
    expect(isSafeExternalLinkUrl("http://localhost:8080/cb")).toBe(false);
    expect(isSafeExternalLinkUrl("http://127.0.0.1:53682/")).toBe(false);
    expect(isSafeExternalLinkUrl("http://example.com")).toBe(false);
  });

  it("rejects dangerous and non-http(s) schemes", () => {
    expect(isSafeExternalLinkUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalLinkUrl("JavaScript:alert(1)")).toBe(false);
    expect(
      isSafeExternalLinkUrl("data:text/html,<script>alert(1)</script>")
    ).toBe(false);
    expect(isSafeExternalLinkUrl("vbscript:msgbox(1)")).toBe(false);
    expect(isSafeExternalLinkUrl("file:///etc/passwd")).toBe(false);
  });

  it("rejects non-strings, empties, and unparseable values", () => {
    expect(isSafeExternalLinkUrl(undefined)).toBe(false);
    expect(isSafeExternalLinkUrl(null)).toBe(false);
    expect(isSafeExternalLinkUrl(123)).toBe(false);
    expect(isSafeExternalLinkUrl("")).toBe(false);
    expect(isSafeExternalLinkUrl("not a url")).toBe(false);
    expect(isSafeExternalLinkUrl("/relative/path")).toBe(false);
  });
});

describe("filterSafeExternalLinkUrls", () => {
  it("keeps only safe links, deduped and order-preserving", () => {
    const input = [
      "https://github.com/login/device",
      "javascript:alert(1)",
      "https://github.com/login/device", // dup
      "data:text/html,x",
      "http://localhost:9000/cb", // plain http dropped
      "https://microsoft.com/devicelogin",
      42,
      null,
    ];
    expect(filterSafeExternalLinkUrls(input)).toEqual([
      "https://github.com/login/device",
      "https://microsoft.com/devicelogin",
    ]);
  });

  it("returns [] for a non-array input", () => {
    expect(filterSafeExternalLinkUrls(undefined)).toEqual([]);
    expect(filterSafeExternalLinkUrls("https://x.com")).toEqual([]);
    expect(filterSafeExternalLinkUrls({})).toEqual([]);
  });
});
