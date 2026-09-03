/**
 * Deriving the per-server view origin label.
 *
 * An origin is where OAuth redirect URIs point and what third-party API-key
 * allowlists name, so the property that matters is stability: the same server
 * must always produce the same label, and two different servers must not
 * collide.
 */
import { describe, it, expect } from "vitest";
import {
  canonicalServerKey,
  VIEW_ORIGIN_LABEL_PATTERN,
  viewOriginLabel,
  viewOriginLabelForConfig,
} from "../view-origin-label.js";

describe("canonicalServerKey", () => {
  it("keys an HTTP server on its URL", () => {
    expect(canonicalServerKey({ url: "https://example.com/mcp" })).toBe(
      "http:https://example.com/mcp",
    );
  });

  it("strips query and fragment", () => {
    // A hosted server URL can carry a resolved token in its query. Hashing
    // that would key the origin on a secret and rotate it whenever the secret
    // did — invalidating every allowlist a developer had configured.
    expect(
      canonicalServerKey({ url: "https://example.com/mcp?token=s3cret#x" }),
    ).toBe(canonicalServerKey({ url: "https://example.com/mcp" }));
  });

  it("keeps a trailing slash significant, as the URL itself is", () => {
    expect(canonicalServerKey({ url: "https://example.com/mcp/" })).not.toBe(
      canonicalServerKey({ url: "https://example.com/mcp" }),
    );
  });

  it("keys a STDIO server on its command and args", () => {
    expect(
      canonicalServerKey({ command: "npx", args: ["-y", "server"] }),
    ).toBe("stdio:npx -y server");
    expect(canonicalServerKey({ command: "npx" })).toBe("stdio:npx");
  });

  it("prefers the URL when a config somehow carries both", () => {
    expect(
      canonicalServerKey({ url: "https://example.com/mcp", command: "npx" }),
    ).toBe("http:https://example.com/mcp");
  });

  it("keeps an unparseable URL rather than dropping the identity", () => {
    expect(canonicalServerKey({ url: "not a url" })).toBe("http:not a url");
  });

  it("identifies nothing when the config has neither", () => {
    expect(canonicalServerKey({})).toBeUndefined();
    expect(canonicalServerKey(undefined)).toBeUndefined();
    expect(canonicalServerKey({ url: "", command: "" })).toBeUndefined();
  });
});

describe("viewOriginLabel", () => {
  it("is a 16-character hex label usable as a DNS label", () => {
    const label = viewOriginLabel("http:https://example.com/mcp");
    expect(label).toMatch(VIEW_ORIGIN_LABEL_PATTERN);
  });

  it("is stable for the same key", () => {
    // Pinned rather than recomputed: a test that derived the expected value
    // the same way the code does would agree with any change to either.
    // Verified independently:
    //   printf '%s' 'http:https://example.com/mcp' | shasum -a 256
    expect(viewOriginLabel("http:https://example.com/mcp")).toBe(
      "4c17a6ac61e19736",
    );
  });

  it("differs for different servers", () => {
    expect(viewOriginLabel("http:https://a.example/mcp")).not.toBe(
      viewOriginLabel("http:https://b.example/mcp"),
    );
    expect(viewOriginLabel("stdio:npx -y a")).not.toBe(
      viewOriginLabel("stdio:npx -y b"),
    );
  });

  it("does not collide across transports", () => {
    expect(viewOriginLabelForConfig({ url: "x" })).not.toBe(
      viewOriginLabelForConfig({ command: "x" }),
    );
  });
});
