import { describe, expect, it } from "vitest";
import { sanitizeHostedOAuthErrorMessage } from "@/lib/hosted-oauth-resume";

describe("sanitizeHostedOAuthErrorMessage", () => {
  it("maps transport-heavy 401 errors to user-friendly copy", () => {
    expect(
      sanitizeHostedOAuthErrorMessage(
        'Authentication failed for MCP server "mn70g96re2qn05cxjw7y4y26ah82jzgh": SSE error: SSE error: Non-200 status code (401)',
        "Authorization could not be completed. Try again.",
      ),
    ).toBe(
      "Your authorization expired or was rejected. Authorize again to continue.",
    );
  });

  it("strips stack trace wrappers before applying copy rules", () => {
    expect(
      sanitizeHostedOAuthErrorMessage(
        "Uncaught Error: invalid_token from hosted validation at async handler (oauth.ts:42:7)",
        "Authorization could not be completed. Try again.",
      ),
    ).toBe(
      "Your authorization expired or was rejected. Authorize again to continue.",
    );
  });

  it("preserves already-safe plain-language errors", () => {
    expect(
      sanitizeHostedOAuthErrorMessage(
        "Authorization was cancelled. Try again.",
        "Authorization could not be completed. Try again.",
      ),
    ).toBe("Authorization was cancelled. Try again.");
  });
});
