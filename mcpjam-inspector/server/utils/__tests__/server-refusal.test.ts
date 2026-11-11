import { describe, expect, it } from "vitest";
import {
  describeServerRefusal,
  nameServerRefusal,
  skippedServerDetails,
} from "../server-refusal.js";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";

describe("server refusal descriptions", () => {
  it.each([
    [
      400,
      "FEATURE_NOT_SUPPORTED",
      "hosted_requires_https",
      "hosted_requires_https",
      "Use an https:// URL",
    ],
    [
      400,
      "FEATURE_NOT_SUPPORTED",
      "hosted_stdio_unsupported",
      "hosted_stdio_unsupported",
      "Run MCPJam locally",
    ],
    [
      401,
      "UNAUTHORIZED",
      undefined,
      "needs_sign_in",
      "Sign in from the Servers page",
    ],
    [
      503,
      "SERVER_UNREACHABLE",
      undefined,
      "unreachable",
      "Check that the server is running",
    ],
    [400, "FEATURE_NOT_SUPPORTED", undefined, "other", "Original refusal"],
    [
      400,
      "FEATURE_NOT_SUPPORTED",
      "future_reason",
      "other",
      "Original refusal",
    ],
  ])("classifies %s %s %s", (status, code, refusalReason, reason, fix) => {
    const described = describeServerRefusal({
      serverName: "Calendar",
      status,
      code,
      message: "Original refusal",
      refusalReason,
    });
    expect(described.reason).toBe(reason);
    expect(described.message).toContain('"Calendar"');
    expect(described.message).toContain(fix);
  });

  it("preserves retry headers and reporting source and names an error only once", () => {
    const error = new WebRouteError(
      429,
      ErrorCode.RATE_LIMITED,
      "Retry shortly",
    ).withHeaders({ "Retry-After": "2" });
    error.setupFailureSource = "oauth_refresh";
    nameServerRefusal(error, "calendar", "Calendar");
    const once = error.message;
    nameServerRefusal(error, "calendar", "Calendar");
    expect(error.message).toBe(once);
    expect(error.headers).toEqual({ "Retry-After": "2" });
    expect(error.setupFailureSource).toBe("oauth_refresh");
  });

  it("keeps internal failures intact", () => {
    const error = new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Missing result",
    );
    nameServerRefusal(error, "calendar", "Calendar");
    expect(error.message).toBe("Missing result");
    expect(error.details).toBeUndefined();
  });

  it("preserves the organization policy remedy for exported credentials", () => {
    const message = 'Your organization keeps saved credentials for "Calendar" inside MCPJam-hosted connections. Ask an organization admin to change the credential export policy.';
    const error = new WebRouteError(403, ErrorCode.FORBIDDEN, message, { exportDenied: true });
    nameServerRefusal(error, "calendar", "Calendar");
    expect(error.message).toBe(message);
    expect(error.details?.serverRefusalReason).toBe("other");
  });

  it("does not blame a server for the credential service being unavailable", () => {
    const error = new WebRouteError(502, ErrorCode.SERVER_UNREACHABLE, "Credential service unavailable");
    error.setupFailureSource = "secret_reveal";
    nameServerRefusal(error, "calendar", "Calendar");
    expect(error.message).toBe("Credential service unavailable");
    expect(error.details).toBeUndefined();
  });

  it("reports skipped servers in selection order without including healthy servers", () => {
    const failure = new WebRouteError(
      400,
      ErrorCode.FEATURE_NOT_SUPPORTED,
      "Hosted refusal",
      { refusalReason: "hosted_requires_https" },
    );
    expect(
      skippedServerDetails(
        { calendar: failure },
        ["healthy", "calendar"],
        ["Healthy", "Calendar"],
      ),
    ).toEqual([
      {
        serverId: "calendar",
        serverName: "Calendar",
        reason: "hosted_requires_https",
        message:
          '"Calendar" uses an http:// URL, which the hosted app can\'t reach. Use an https:// URL or run MCPJam locally.',
      },
    ]);
  });
});
