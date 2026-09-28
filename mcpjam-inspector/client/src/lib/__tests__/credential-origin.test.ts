/**
 * MJ-003 — when the edit form must warn that saving will destroy credentials.
 *
 * Two failure modes, opposite and both bad: warning on the common harmless edit
 * teaches people to click through, so it is not there when it matters; not
 * warning on a destination change means the backend silently wipes a credential
 * somebody else entered. The cases below pin both edges, for both vectors the
 * backend clears on — a cross-origin url, and a stdio `command`/`args` swap.
 */

import { describe, expect, it } from "vitest";

import {
  credentialClearAcknowledgementKey,
  credentialOriginOf,
  pendingCredentialClearForStdioTargetEdit,
  pendingCredentialClearForUrlEdit,
  rowHoldsStoredCredential,
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
    savedUrl: "https://owner.example.com/mcp",
  };

  it("warns on a cross-origin move, naming both hosts", () => {
    expect(
      pendingCredentialClearForUrlEdit({
        ...base,
        nextUrl: "https://elsewhere.example.com/mcp",
      })
    ).toEqual({
      kind: "url-origin",
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

  it("stays silent on a re-save that changes nothing", () => {
    expect(
      pendingCredentialClearForUrlEdit({ ...base, nextUrl: base.savedUrl })
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

  it("warns even when this browser cannot see stored OAuth credentials", () => {
    expect(
      pendingCredentialClearForUrlEdit({
        savedUrl: "https://owner.example.com/mcp",
        nextUrl: "https://elsewhere.example.com/mcp",
      }),
    ).not.toBeNull();
  });

  it("stays silent while the URL is still being typed", () => {
    // Fires on almost every keystroke otherwise. The form's own validation owns
    // an unparseable URL; this is not the place to report it.
    // Not `https://part`: that parses to a real, different origin, so warning
    // on it is correct — a half-typed HOSTNAME is indistinguishable from a
    // deliberate one, and staying silent would mean no warning on the save.
    for (const nextUrl of ["", "https://", "htt", "example.com/mcp"]) {
      expect(pendingCredentialClearForUrlEdit({ ...base, nextUrl })).toBeNull();
    }
  });

  it("stays silent on a new server with nothing saved yet", () => {
    expect(
      pendingCredentialClearForUrlEdit({
        savedUrl: null,
        nextUrl: "https://elsewhere.example.com/mcp",
      })
    ).toBeNull();
  });
});

/**
 * The vector the form said nothing about until now: a stdio row's `command` is
 * where its env secret gets delivered, so swapping it is the same exfiltration
 * as a repoint. The backend clears on it (mcpjam-backend#1260) and did so with
 * no warning at all on this side.
 */
describe("pendingCredentialClearForStdioTargetEdit", () => {
  const base = {
    holdsStoredCredential: true,
    savedCommand: "npx",
    savedArgs: ["-y", "@modelcontextprotocol/server-everything"],
  };

  it("warns on a command swap, naming both invocations in full", () => {
    expect(
      pendingCredentialClearForStdioTargetEdit({
        ...base,
        nextCommand: "node",
        nextArgs: ["exfiltrate.js"],
      })
    ).toEqual({
      kind: "stdio-target",
      previousCommand: "npx -y @modelcontextprotocol/server-everything",
      nextCommand: "node exfiltrate.js",
    });
  });

  it("warns when only an argument changes", () => {
    // `npx → npx` would be a useless warning, so the whole invocation is what
    // gets named.
    expect(
      pendingCredentialClearForStdioTargetEdit({
        ...base,
        nextCommand: "npx",
        nextArgs: ["-y", "@attacker/collector"],
      })
    ).toMatchObject({
      nextCommand: "npx -y @attacker/collector",
    });
  });

  it("stays silent on a re-save that changes nothing", () => {
    expect(
      pendingCredentialClearForStdioTargetEdit({
        ...base,
        nextCommand: "npx",
        nextArgs: ["-y", "@modelcontextprotocol/server-everything"],
      })
    ).toBeNull();
  });

  it("treats absent args and [] as the same invocation", () => {
    // The backend compares args element-wise and reads absent as empty, so a
    // row that never stored args being written `[]` is not a change and must
    // not warn about a clear that will not happen.
    expect(
      pendingCredentialClearForStdioTargetEdit({
        holdsStoredCredential: true,
        savedCommand: "run-server",
        savedArgs: undefined,
        nextCommand: "run-server",
        nextArgs: [],
      })
    ).toBeNull();
  });

  it("counts a reordering of the same arguments as a change", () => {
    expect(
      pendingCredentialClearForStdioTargetEdit({
        holdsStoredCredential: true,
        savedCommand: "server",
        savedArgs: ["--a", "--b"],
        nextCommand: "server",
        nextArgs: ["--b", "--a"],
      })
    ).not.toBeNull();
  });

  it("stays silent when the row holds no stored credential", () => {
    // The backend gates this trigger on the row holding something, unlike the
    // origin one. Warning here would be crying wolf on an ordinary edit.
    expect(
      pendingCredentialClearForStdioTargetEdit({
        ...base,
        holdsStoredCredential: false,
        nextCommand: "node",
        nextArgs: [],
      })
    ).toBeNull();
  });

  it("stays silent while the command is being retyped from empty", () => {
    expect(
      pendingCredentialClearForStdioTargetEdit({
        ...base,
        nextCommand: "",
        nextArgs: [],
      })
    ).toBeNull();
  });

  it("stays silent on a row with no saved command", () => {
    expect(
      pendingCredentialClearForStdioTargetEdit({
        holdsStoredCredential: true,
        savedCommand: null,
        savedArgs: [],
        nextCommand: "node",
        nextArgs: [],
      })
    ).toBeNull();
  });
});

describe("credentialClearAcknowledgementKey", () => {
  it("changes with the destination, so consent does not carry across", () => {
    const first = credentialClearAcknowledgementKey({
      kind: "url-origin",
      previousOrigin: "https://owner.example.com",
      nextOrigin: "https://one.example.com",
    });
    const second = credentialClearAcknowledgementKey({
      kind: "url-origin",
      previousOrigin: "https://owner.example.com",
      nextOrigin: "https://two.example.com",
    });
    expect(first).not.toBe(second);
  });

  it("keeps the two vectors apart", () => {
    expect(
      credentialClearAcknowledgementKey({
        kind: "stdio-target",
        previousCommand: "npx a",
        nextCommand: "node b",
      })
    ).not.toBe(
      credentialClearAcknowledgementKey({
        kind: "url-origin",
        previousOrigin: "npx a",
        nextOrigin: "node b",
      })
    );
  });
});

/**
 * The review found `holdsStoredCredential` under-reporting in two ways, both of
 * which meant a save silently destroyed credentials with no warning. The
 * predicate now reads the ROW, so these pin the shapes it has to recognise.
 */
describe("which rows count as holding a stored credential", () => {
  it.each([
    ["hasEnv", { hasEnv: true }],
    ["hasHeaders", { hasHeaders: true }],
    ["hasBearerToken", { hasBearerToken: true }],
    ["hasClientSecret", { hasClientSecret: true }],
    // The backend clears every hostedOAuthCredentials row on an origin change,
    // and an OAuth-connected server may hold nothing else. There is no
    // `hasOAuthTokens` redaction flag, so the tokens themselves are the signal.
    ["stored OAuth tokens", { oauthTokens: { access_token: "x" } }],
    // Visible plaintext headers, the local path where nothing is redacted.
    // `hasHeaders` is false for these BY DESIGN — it means "stored and hidden"
    // — so keying the warning off it missed a row that genuinely holds
    // credentials the backend will wipe.
    [
      "plaintext headers on the row",
      { config: { requestInit: { headers: { "X-Api-Key": "value" } } } },
    ],
    // Same for env, and this is the shape the stdio warning lives or dies on:
    // a local stdio row keeps its environment in the clear.
    ["plaintext env on the row", { config: { env: { API_KEY: "value" } } }],
  ])("%s alone counts", (_label, server) => {
    expect(rowHoldsStoredCredential(server)).toBe(true);
  });

  it.each([
    ["nothing stored", {}],
    ["flags explicitly false", { hasEnv: false, hasHeaders: false }],
    ["an empty header record", { config: { requestInit: { headers: {} } } }],
    [
      "a header present but empty",
      { config: { requestInit: { headers: { "X-Api-Key": "" } } } },
    ],
    ["an empty env record", { config: { env: {} } }],
    ["oauthTokens null", { oauthTokens: null }],
    // A non-record `headers` is not a credential. The mirrored copy this suite
    // used to run answered `true` here, which is the drift that made it useless.
    [
      "a header array rather than a record",
      { config: { requestInit: { headers: ["x"] } } },
    ],
  ])("%s does not count", (_label, server) => {
    expect(rowHoldsStoredCredential(server)).toBe(false);
  });
});
