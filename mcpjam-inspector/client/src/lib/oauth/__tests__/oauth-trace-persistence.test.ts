import { beforeEach, describe, expect, it } from "vitest";
import {
  saveOAuthTrace,
  saveOAuthTraceToSession,
  type OAuthTrace,
} from "../oauth-trace";

describe("OAuth trace persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it.each(["local", "session"])(
    "redacts credentials before writing %s storage without mutating live diagnostics",
    (kind) => {
      const trace: OAuthTrace = {
        version: 1,
        source: "interactive_connect",
        serverName: "example",
        currentStep: "token_request",
        steps: [],
        httpHistory: [
          {
            step: "token_request",
          request: {
              method: "POST",
              url: "https://example.com/token",
              headers: { Authorization: "Bearer secret-header-credential" },
              body: {
                client_secret: "secret-client-credential",
                code_verifier: "secret-verifier-credential",
              },
            },
            response: {
              status: 200,
              statusText: "OK",
              headers: {},
              body: {
                access_token: "secret-access-credential",
                refresh_token: "secret-refresh-credential",
              },
            },
            timestamp: 1,
          },
        ],
      };
      const original = JSON.stringify(trace);
      if (kind === "local") saveOAuthTrace("example", trace);
      else saveOAuthTraceToSession("example", trace);
      const stored = (kind === "local" ? localStorage : sessionStorage).getItem(
        kind === "local"
          ? "mcp-oauth-trace-example"
          : "mcp-oauth-session-trace-example",
      )!;
      expect(stored).toContain("[redacted]");
      for (const secret of [
        "secret-header-credential",
        "secret-client-credential",
        "secret-verifier-credential",
        "secret-access-credential",
        "secret-refresh-credential",
      ]) {
        expect(stored).not.toContain(secret);
      }
      expect(JSON.stringify(trace)).toBe(original);
    },
  );
});
