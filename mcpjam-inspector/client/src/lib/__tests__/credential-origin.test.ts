/**
 * MJ-003 — when the edit form must warn that saving will destroy credentials.
 *
 * Two failure modes, opposite and both bad: warning on the common harmless edit
 * teaches people to click through, so it is not there when it matters; not
 * warning on a cross-origin save means the backend silently wipes a credential
 * somebody else entered. The cases below pin both edges.
 */

import { describe, expect, it } from "vitest";

import {
  credentialOriginOf,
  pendingCredentialClearForUrlEdit,
} from "../credential-origin";

describe("credentialOriginOf", () => {
  it.each([
    ["https://a.example.com/mcp", "https://a.example.com"],
    ["https://a.example.com:443/mcp", "https://a.example.com"],
    ["http://a.example.com:80/mcp", "http://a.example.com"],
    ["https://a.example.com:8443/mcp", "https://a.example.com:8443"],
    ["https://A.Example.COM/mcp", "https://a.example.com"],
    ["https://a.example.com./mcp", "https://a.example.com"],
  ])("%s -> %s", (input, expected) => {
    expect(credentialOriginOf(input)).toBe(expected);
  });

  it.each([[""], ["   "], ["not a url"], ["/mcp"], ["file:///etc/passwd"]])(
    "%s is unusable",
    (input) => {
      expect(credentialOriginOf(input)).toBeNull();
    }
  );
});

describe("pendingCredentialClearForUrlEdit", () => {
  const base = {
    holdsStoredCredential: true,
    savedUrl: "https://owner.example.com/mcp",
  };

  it("warns on a cross-origin move, naming both hosts", () => {
    expect(
      pendingCredentialClearForUrlEdit({
        ...base,
        nextUrl: "https://elsewhere.example.com/mcp",
      })
    ).toEqual({
      previousOrigin: "https://owner.example.com",
      nextOrigin: "https://elsewhere.example.com",
    });
  });

  it("stays silent on a same-origin path edit", () => {
    // The common legitimate edit. A warning here is the one that gets
    // click-trained away.
    expect(
      pendingCredentialClearForUrlEdit({
        ...base,
        nextUrl: "https://owner.example.com/mcp/v2",
      })
    ).toBeNull();
  });

  it("warns on a scheme downgrade and on a port change", () => {
    expect(
      pendingCredentialClearForUrlEdit({
        ...base,
        nextUrl: "http://owner.example.com/mcp",
      })
    ).not.toBeNull();
    expect(
      pendingCredentialClearForUrlEdit({
        ...base,
        nextUrl: "https://owner.example.com:8443/mcp",
      })
    ).not.toBeNull();
  });

  it("stays silent when the row holds no stored credential", () => {
    expect(
      pendingCredentialClearForUrlEdit({
        holdsStoredCredential: false,
        savedUrl: "https://owner.example.com/mcp",
        nextUrl: "https://elsewhere.example.com/mcp",
      })
    ).toBeNull();
  });

  it("stays silent while the URL is still being typed", () => {
    // Fires on almost every keystroke otherwise. The form's own validation owns
    // an unparseable URL; this is not the place to report it.
    // Not `https://part`: that parses to a real, different origin, so warning
    // on it is correct — a half-typed HOSTNAME is indistinguishable from a
    // deliberate one, and staying silent would mean no warning on the save.
    for (const nextUrl of ["", "https://", "htt", "example.com/mcp"]) {
      expect(
        pendingCredentialClearForUrlEdit({ ...base, nextUrl })
      ).toBeNull();
    }
  });

  it("stays silent on a new server with nothing saved yet", () => {
    expect(
      pendingCredentialClearForUrlEdit({
        holdsStoredCredential: true,
        savedUrl: null,
        nextUrl: "https://elsewhere.example.com/mcp",
      })
    ).toBeNull();
  });
});
