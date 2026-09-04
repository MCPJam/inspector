import { describe, expect, it } from "vitest";
import { isSpaDocumentRequest } from "../spa-document-request.js";

describe("isSpaDocumentRequest", () => {
  // These are the paths that must reach the injecting document handler. When
  // the catch-all serveStatic answered them first, hosted documents shipped
  // with no runtime config, no session token, no guest bootstrap and no
  // `no-store` — which is how staging's WorkOS hostname config never reached
  // the browser at all.
  it.each(["/", "/servers", "/p/abc123/home", "/embed/score", "/callback"])(
    "routes %s to the document handler",
    (path) => {
      expect(isSpaDocumentRequest(path)).toBe(true);
    },
  );

  // Everything in dist/client has an extension, so this is what keeps real
  // files being served as files rather than swallowed by the SPA fallback.
  it.each([
    "/mcp_jam.svg",
    "/favicon.ico",
    "/assets/index-C1FTdFWO.js",
    "/assets/index-DYymtqx-.css",
    "/demo_1.png",
  ])("leaves %s to the static handler", (path) => {
    expect(isSpaDocumentRequest(path)).toBe(false);
  });

  // A dot earlier in the path is not a file extension — only the last segment
  // decides, or a project route carrying a dotted id would 404.
  it("only considers the last path segment", () => {
    expect(isSpaDocumentRequest("/p/some.project/servers")).toBe(true);
  });
});
