import { beforeEach, describe, expect, it } from "vitest";
import {
  loadOAuthTrace,
  loadOAuthTraceFromSession,
  saveOAuthTrace,
  saveOAuthTraceToSession,
  type OAuthTrace,
} from "../oauth-trace";

describe("OAuth trace persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("does not persist unknown protocol identifiers or attacker-supplied titles", () => {
    const trace = {
      version: 1, source: "opaque-secret", currentStep: "opaque-secret",
      steps: [{ step: "opaque-secret", title: "opaque-secret", status: "opaque-secret", startedAt: 1 }],
      httpHistory: [],
    } as unknown as OAuthTrace;
    saveOAuthTrace("unknown", trace);
    const stored = localStorage.getItem("mcp-oauth-trace-unknown")!;
    expect(stored).not.toContain("opaque-secret");
    expect(JSON.parse(stored)).toMatchObject({ currentStep: "idle", steps: [{ step: "idle", status: "pending" }] });
  });

  it.each(["local", "session"])(
    "stores only progress in %s storage without mutating live diagnostics",
    (kind) => {
      const trace: OAuthTrace = {
        version: 1,
        source: "interactive_connect",
        serverName: "example",
        currentStep: "token_request",
        error: "unstructured-secret-credential",
        serverUrl: "https://user:password@example.com/?opaque=unstructured-secret-credential",
        steps: [{ step: "token_request", title: "unstructured-secret-credential", status: "error", startedAt: 1, error: "unstructured-secret-credential", details: { opaque: "unstructured-secret-credential" } }],
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
      expect(JSON.parse(stored).httpHistory).toEqual([]);
      expect(JSON.parse(stored).steps[0]).toMatchObject({ step: "token_request", status: "error", startedAt: 1 });
      expect(stored).not.toContain("unstructured-secret-credential");
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
      const storage = kind === "local" ? localStorage : sessionStorage;
      const key = kind === "local" ? "mcp-oauth-trace-example" : "mcp-oauth-session-trace-example";
      storage.setItem(key, original);
      const loaded = kind === "local" ? loadOAuthTrace("example") : loadOAuthTraceFromSession("example");
      expect(loaded?.httpHistory).toEqual([]);
      expect(storage.getItem(key)).not.toContain("unstructured-secret-credential");
    },
  );
});
