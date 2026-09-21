import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as oauthNode from "../src/oauth/node.js";
import * as oauthProxy from "../src/oauth-proxy.js";
import * as ssrfGuard from "../src/oauth/ssrf-guard.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const ENTRY = resolve(SRC, "oauth/node.ts");

describe("@mcpjam/sdk/oauth/node entry", () => {
  // The whole point of the entry is that the backend runs the SAME guard the
  // Inspector runs. Identity equality is what proves that: a fork would still
  // satisfy a typeof check.
  it.each([
    ["assertOutboundOAuthUrlAllowed"],
    ["isDisallowedIpAddress"],
    ["isLoopbackOAuthUrl"],
    ["isPrivateHost"],
    ["OAuthOutboundUrlBlockedError"],
  ])("re-exports %s from the shared ssrf-guard, not a copy", (name) => {
    expect(oauthNode[name as keyof typeof oauthNode]).toBe(
      ssrfGuard[name as keyof typeof ssrfGuard]
    );
  });

  it.each([
    ["executeDebugOAuthProxy"],
    ["executeOAuthProxy"],
    ["fetchOAuthMetadata"],
    ["fetchPinnedPublicDocument"],
    ["OAuthProxyError"],
    ["validateUrl"],
  ])("re-exports %s from the pinned Node proxy, not a copy", (name) => {
    expect(oauthNode[name as keyof typeof oauthNode]).toBe(
      oauthProxy[name as keyof typeof oauthProxy]
    );
  });

  it("re-exports the streaming transport from its own module, not a copy", async () => {
    const streaming = await import("../src/oauth/pinned-stream-fetch.js");
    expect(oauthNode.createPinnedStreamingFetch).toBe(
      streaming.createPinnedStreamingFetch
    );
  });

  it("exposes nothing beyond the documented surface", () => {
    expect(Object.keys(oauthNode).sort()).toEqual([
      "OAuthOutboundUrlBlockedError",
      "OAuthProxyError",
      "assertOutboundOAuthUrlAllowed",
      "createPinnedStreamingFetch",
      "executeDebugOAuthProxy",
      "executeOAuthProxy",
      "fetchOAuthMetadata",
      "fetchPinnedPublicDocument",
      "isDisallowedIpAddress",
      "isLoopbackOAuthUrl",
      "isPrivateHost",
      "validateUrl",
    ]);
  });

  // A Convex action importing this entry must not drag in `ai`, the provider
  // packages, or anything else with its own transitive weight. Assert the
  // property rather than the current import list, so the check still fires when
  // someone adds a heavy import three modules deep in `oauth-proxy.ts`.
  it("reaches only node: builtins across its whole import graph", () => {
    const seen = new Set<string>();
    const external = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      // Static `import`/`export ... from "..."` specifiers only; these are what
      // a bundler and a Node ESM loader both resolve eagerly.
      for (const match of source.matchAll(/\bfrom\s+"([^"]+)"/g)) {
        const specifier = match[1];
        if (!specifier.startsWith(".")) {
          external.add(specifier);
          continue;
        }
        visit(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
      }
    };
    visit(ENTRY);

    expect([...external].sort()).toEqual([
      "node:dns",
      "node:http",
      "node:https",
      "node:net",
      // `node:zlib` is the streaming transport undoing `content-encoding`, so
      // its byte cap counts DECOMPRESSED bytes and a compressed bomb is
      // measured at the size it will actually occupy.
      "node:zlib",
    ]);
  });
});
