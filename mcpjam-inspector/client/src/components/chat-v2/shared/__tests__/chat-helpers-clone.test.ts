import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { cloneUiMessages, formatErrorMessage } from "../chat-helpers";

describe("cloneUiMessages", () => {
  it("deep-clones so mutations do not affect the source", () => {
    const original: UIMessage[] = [
      {
        id: "1",
        role: "user",
        parts: [{ type: "text", text: "a" }],
      },
    ];
    const copy = cloneUiMessages(original);
    expect(copy).not.toBe(original);
    expect(copy[0]).not.toBe(original[0]);
    expect(copy[0]?.parts).not.toBe(original[0]?.parts);
    (copy[0]?.parts[0] as { text?: string }).text = "b";
    expect((original[0]?.parts[0] as { text?: string }).text).toBe("a");
  });
});

describe("formatErrorMessage", () => {
  it("turns MCPJam model-limit JSON into actionable quota copy", () => {
    const result = formatErrorMessage(
      JSON.stringify({
        code: "user_rate_limit",
        error:
          "Daily MCPJam model limit reached. Use BYOK or try again tomorrow.",
        retryAfter: 4500000,
        details: "Try again in 75 minutes.",
      }),
    );

    expect(result).toEqual({
      code: "user_rate_limit",
      message:
        "Add your own API key in Settings > LLM Providers to keep chatting now, or try again in 1 hour 15 minutes.",
      isRetryable: false,
      isMCPJamPlatformError: true,
    });
  });

  it("surfaces canTopUp when present", () => {
    const result = formatErrorMessage(
      JSON.stringify({
        ok: false,
        code: "user_rate_limit",
        limitKind: "total",
        error:
          "Daily MCPJam model limit reached. Use BYOK or try again tomorrow.",
        isRetryable: true,
        retryAfter: 4500000,
        details: "Try again in 75 minutes.",
        canTopUp: true,
      }),
    );

    expect(result).toEqual({
      code: "user_rate_limit",
      message:
        "Add your own API key in Settings > LLM Providers to keep chatting now, or try again in 1 hour 15 minutes.",
      isRetryable: false,
      isMCPJamPlatformError: true,
      canTopUp: true,
      limitKind: "total",
    });
  });

  it("surfaces canTopUp:false for guests", () => {
    const result = formatErrorMessage(
      JSON.stringify({
        code: "user_rate_limit",
        error: "Daily MCPJam model limit reached.",
        retryAfter: 4500000,
        canTopUp: false,
      }),
    );

    expect(result).toEqual({
      code: "user_rate_limit",
      message:
        "Add your own API key in Settings > LLM Providers to keep chatting now, or try again in 1 hour 15 minutes.",
      isRetryable: false,
      isMCPJamPlatformError: true,
      canTopUp: false,
    });
  });

  it("omits canTopUp when the server does not send it", () => {
    const result = formatErrorMessage(
      JSON.stringify({
        code: "user_rate_limit",
        error: "Daily MCPJam model limit reached.",
        retryAfter: 4500000,
      }),
    );

    expect(result).not.toHaveProperty("canTopUp");
  });

  it("uses neutral billing copy when retry details are unavailable", () => {
    const result = formatErrorMessage(
      JSON.stringify({
        code: "user_rate_limit",
      }),
    );

    expect(result).toEqual({
      code: "user_rate_limit",
      message:
        "Add your own API key in Settings > LLM Providers to keep chatting now, or add credits from Billing.",
      isRetryable: false,
      isMCPJamPlatformError: true,
    });
  });

  it("does not leak JSON delimiters from structured retry details", () => {
    const result = formatErrorMessage(
      JSON.stringify({
        error: "Daily MCPJam model limit reached.",
        details: { hint: "Try again in 75 minutes" },
      }),
    );

    expect(result).toEqual({
      code: "mcpjam_rate_limit",
      message:
        "Add your own API key in Settings > LLM Providers to keep chatting now, or try again in 1 hour 15 minutes.",
      isRetryable: false,
      isMCPJamPlatformError: true,
    });
  });

  it("turns large minute counts into readable reset copy", () => {
    const result = formatErrorMessage(
      JSON.stringify({
        message:
          "Daily MCPJam model limit reached. Use BYOK or try again tomorrow.",
        details: "Try again in 1390 minutes.",
      }),
    );

    expect(result).toEqual({
      code: "mcpjam_rate_limit",
      message:
        "Add your own API key in Settings > LLM Providers to keep chatting now, or try again tomorrow.",
      isRetryable: false,
      isMCPJamPlatformError: true,
    });
  });

  it("recognizes plain MCPJam model-limit messages", () => {
    const result = formatErrorMessage(
      "Daily MCPJam model limit reached. Use BYOK or try again tomorrow.",
    );

    expect(result).toEqual({
      code: "mcpjam_rate_limit",
      message:
        "Add your own API key in Settings > LLM Providers to keep chatting now, or try again tomorrow.",
      isRetryable: false,
      isMCPJamPlatformError: true,
    });
  });

  it("surfaces walletLocked: true on the formatted error", () => {
    const result = formatErrorMessage(
      JSON.stringify({
        ok: false,
        code: "wallet_locked",
        limitKind: "total",
        error: "Top-up is unavailable on this account. Contact support to resolve.",
        isRetryable: false,
        retryAfter: 0,
        details:
          "A recent payment was disputed. Wallet spend is paused pending review.",
        canTopUp: false,
        walletLocked: true,
      }),
    );

    expect(result?.walletLocked).toBe(true);
    expect(result?.code).toBe("wallet_locked");
    expect(result?.canTopUp).toBe(false);
    expect(result?.limitKind).toBe("total");
  });

  it("surfaces limitKind: \"concurrency\" with retryAfterMs for the throttle case", () => {
    const result = formatErrorMessage(
      JSON.stringify({
        ok: false,
        code: "user_rate_limit",
        limitKind: "concurrency",
        error: "Another credit-funded chat is still in flight.",
        isRetryable: true,
        retryAfter: 8000,
        details: "Try again in 8 seconds.",
        canTopUp: false,
      }),
    );

    expect(result?.code).toBe("user_rate_limit");
    expect(result?.limitKind).toBe("concurrency");
    expect(result?.retryAfterMs).toBe(8000);
    expect(result?.canTopUp).toBe(false);
    expect(result).not.toHaveProperty("walletLocked");
  });

  it("does not crash on a legacy 429 without walletLocked or limitKind", () => {
    const result = formatErrorMessage(
      JSON.stringify({
        code: "user_rate_limit",
        error: "Daily MCPJam model limit reached.",
        retryAfter: 4500000,
        canTopUp: true,
      }),
    );

    expect(result?.code).toBe("user_rate_limit");
    expect(result?.canTopUp).toBe(true);
    expect(result).not.toHaveProperty("walletLocked");
    expect(result).not.toHaveProperty("limitKind");
  });

  // Connection failures already reached the playground intact — the AI SDK
  // throws `new Error(await response.text())`, so the server's JSON parses
  // fine here. What reached the user was the backend's own wording: a dead
  // OAuth grant rendered as "Authorization failed", an unreachable server as
  // "fetch failed". Accurate, and useless. These pin the human copy.
  describe("connection failures", () => {
    it("explains an unreachable server", () => {
      const result = formatErrorMessage(
        JSON.stringify({
          code: "SERVER_UNREACHABLE",
          message: "fetch failed",
        }),
      );

      expect(result?.message).toBe(
        "Couldn't reach the MCP server. It may be offline or blocking the connection.",
      );
      // The server's own wording stays reachable under "More details".
      expect(result?.details).toBe("fetch failed");
    });

    // Copy-only: every non-message field is passed through untouched, so the
    // banner's Retry button behaves exactly as it did before this change.
    it("passes isRetryable through from the server rather than deriving it", () => {
      const retryable = formatErrorMessage(
        JSON.stringify({
          code: "SERVER_UNREACHABLE",
          message: "fetch failed",
          isRetryable: true,
        }),
      );
      expect(retryable?.isRetryable).toBe(true);

      const notRetryable = formatErrorMessage(
        JSON.stringify({
          code: "SERVER_UNREACHABLE",
          message: "fetch failed",
          isRetryable: false,
        }),
      );
      expect(notRetryable?.isRetryable).toBe(false);
    });

    it("names the server when the backend supplies one", () => {
      const result = formatErrorMessage(
        JSON.stringify({
          code: "SERVER_UNREACHABLE",
          message: "fetch failed",
          details: { serverName: "BART MCP" },
        }),
      );

      expect(result?.message).toBe(
        "Couldn't reach “BART MCP”. It may be offline or blocking the connection.",
      );
    });

    // The banner no longer leads with the server's wording, so "More details"
    // is the only place it survives. Structured details must not displace it.
    it("keeps the raw server message alongside structured details", () => {
      const result = formatErrorMessage(
        JSON.stringify({
          code: "SERVER_UNREACHABLE",
          message: "fetch failed",
          details: { serverName: "BART MCP" },
        }),
      );

      expect(result?.details).toContain("fetch failed");
      expect(result?.details).toContain("BART MCP");
      // Still JSON, so ErrorBox renders it through JsonEditor rather than <pre>.
      expect(() => JSON.parse(result!.details!)).not.toThrow();
    });

    it("keeps both when details is a plain string", () => {
      const result = formatErrorMessage(
        JSON.stringify({
          code: "TIMEOUT",
          message: "Connection attempt timed out after 20 seconds",
          details: "upstream did not respond",
        }),
      );

      expect(result?.details).toContain(
        "Connection attempt timed out after 20 seconds",
      );
      expect(result?.details).toContain("upstream did not respond");
    });

    it("does not duplicate a message the details already contain", () => {
      const result = formatErrorMessage(
        JSON.stringify({
          code: "SERVER_UNREACHABLE",
          message: "fetch failed",
          details: "fetch failed (ECONNREFUSED)",
        }),
      );

      expect(result?.details).toBe("fetch failed (ECONNREFUSED)");
    });

    it("tells the user to reconnect an expired OAuth grant", () => {
      const result = formatErrorMessage(
        JSON.stringify({
          code: "UNAUTHORIZED",
          message: "Hosted OAuth refresh token is invalid. Please reconnect.",
          details: {
            oauthRequired: true,
            refreshTokenInvalid: true,
            serverName: "BART MCP",
          },
        }),
      );

      expect(result?.message).toBe(
        "Your connection to “BART MCP” has expired. Reconnect it to keep chatting.",
      );
    });

    it("explains a timeout", () => {
      const result = formatErrorMessage(
        JSON.stringify({
          code: "TIMEOUT",
          message: "Connection attempt timed out after 20 seconds",
          details: { serverName: "BART MCP" },
        }),
      );

      expect(result?.message).toBe("“BART MCP” took too long to respond.");
    });

    // UNAUTHORIZED / FORBIDDEN double as MCPJam's OWN auth failures (expired
    // session, missing bearer) and project-permission denials. Rewriting those
    // into "reconnect your MCP server" would send the user to fix something
    // that isn't broken — strictly worse than the jargon. Only rewrite when a
    // server is actually named.
    it("does not blame the MCP server for an unattributed 401", () => {
      const result = formatErrorMessage(
        JSON.stringify({
          code: "UNAUTHORIZED",
          message: "Missing or invalid bearer token",
        }),
      );

      expect(result?.message).toBe("Missing or invalid bearer token");
    });

    it("does not blame the MCP server for an unattributed 403", () => {
      const result = formatErrorMessage(
        JSON.stringify({
          code: "FORBIDDEN",
          message: "Authorization denied for server",
        }),
      );

      expect(result?.message).toBe("Authorization denied for server");
    });

    it("rewrites a 401 that names a server", () => {
      const result = formatErrorMessage(
        JSON.stringify({
          code: "UNAUTHORIZED",
          message: "Authentication failed",
          details: { serverName: "BART MCP" },
        }),
      );

      expect(result?.message).toBe(
        "“BART MCP” rejected the connection. Reconnect it to refresh your access.",
      );
    });

    it("leaves unrelated codes on the verbatim path", () => {
      const result = formatErrorMessage(
        JSON.stringify({
          code: "VALIDATION_ERROR",
          message: "projectId is invalid",
        }),
      );

      expect(result?.message).toBe("projectId is invalid");
    });

    it("does not divert a rate-limit error onto the connection path", () => {
      const result = formatErrorMessage(
        JSON.stringify({
          code: "user_rate_limit",
          error: "Daily MCPJam model limit reached.",
          retryAfter: 4500000,
        }),
      );

      expect(result?.isMCPJamPlatformError).toBe(true);
      expect(result?.message).toContain("Add your own API key");
    });
  });
});
