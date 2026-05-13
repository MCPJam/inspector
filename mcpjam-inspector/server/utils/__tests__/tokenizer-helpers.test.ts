import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mapModelIdToTokenizerBackend,
  estimateTokensFromChars,
  isFetchConnectionFailure,
  getFetchErrorCause,
  countToolsTokens,
} from "../tokenizer-helpers.js";

describe("mapModelIdToTokenizerBackend", () => {
  describe("Anthropic models", () => {
    it("maps claude-opus-4-1 correctly", () => {
      expect(mapModelIdToTokenizerBackend("claude-opus-4-1")).toBe(
        "anthropic/claude-opus-4.1",
      );
    });

    it("maps claude-sonnet-4-5 correctly", () => {
      expect(mapModelIdToTokenizerBackend("claude-sonnet-4-5")).toBe(
        "anthropic/claude-sonnet-4.5",
      );
    });

    it("maps claude-3-5-sonnet-latest correctly", () => {
      expect(mapModelIdToTokenizerBackend("claude-3-5-sonnet-latest")).toBe(
        "anthropic/claude-3.5-sonnet",
      );
    });

    it("maps prefixed anthropic models", () => {
      expect(
        mapModelIdToTokenizerBackend("anthropic/claude-3-5-sonnet-latest"),
      ).toBe("anthropic/claude-3.5-sonnet");
    });
  });

  describe("OpenAI models", () => {
    it("maps gpt-4o correctly", () => {
      expect(mapModelIdToTokenizerBackend("gpt-4o")).toBe("openai/gpt-4o");
    });

    it("maps gpt-4o-mini correctly", () => {
      expect(mapModelIdToTokenizerBackend("gpt-4o-mini")).toBe(
        "openai/gpt-4o-mini",
      );
    });

    it("maps gpt-5 variants correctly", () => {
      expect(mapModelIdToTokenizerBackend("gpt-5")).toBe("openai/gpt-5");
      expect(mapModelIdToTokenizerBackend("gpt-5-mini")).toBe(
        "openai/gpt-5-mini",
      );
    });
  });

  describe("DeepSeek models", () => {
    it("maps deepseek-chat correctly", () => {
      expect(mapModelIdToTokenizerBackend("deepseek-chat")).toBe(
        "deepseek/deepseek-v3.1",
      );
    });

    it("maps deepseek-reasoner correctly", () => {
      expect(mapModelIdToTokenizerBackend("deepseek-reasoner")).toBe(
        "deepseek/deepseek-r1",
      );
    });
  });

  describe("Google Gemini models", () => {
    it("no longer maps the removed gemini-3-pro-preview alias", () => {
      expect(mapModelIdToTokenizerBackend("gemini-3-pro-preview")).toBe(null);
    });

    it("maps gemini-2.5-pro correctly", () => {
      expect(mapModelIdToTokenizerBackend("gemini-2.5-pro")).toBe(
        "google/gemini-2.5-pro",
      );
    });

    it("maps gemini-2.5-flash correctly", () => {
      expect(mapModelIdToTokenizerBackend("gemini-2.5-flash")).toBe(
        "google/gemini-2.5-flash",
      );
    });
  });

  describe("xAI models", () => {
    it("maps grok-3 correctly", () => {
      expect(mapModelIdToTokenizerBackend("grok-3")).toBe("xai/grok-3");
    });

    it("normalizes x-ai prefix to xai", () => {
      expect(mapModelIdToTokenizerBackend("x-ai/grok-4.1-fast")).toBe(
        "xai/grok-4.1-fast",
      );
    });
  });

  describe("Mistral models", () => {
    it("maps mistral-large-latest correctly", () => {
      expect(mapModelIdToTokenizerBackend("mistral-large-latest")).toBe(
        "mistral/mistral-large",
      );
    });

    it("maps codestral-latest correctly", () => {
      expect(mapModelIdToTokenizerBackend("codestral-latest")).toBe(
        "mistral/codestral",
      );
    });
  });

  describe("provider prefix normalization", () => {
    it("normalizes z-ai to zai", () => {
      expect(mapModelIdToTokenizerBackend("z-ai/glm-4.7")).toBe("zai/glm-4.7");
    });

    it("passes through already normalized prefixes", () => {
      const result = mapModelIdToTokenizerBackend("custom-provider/some-model");
      expect(result).toBe("custom-provider/some-model");
    });
  });

  describe("fallback behavior", () => {
    it("returns null for completely unknown models", () => {
      expect(mapModelIdToTokenizerBackend("unknown-model-xyz")).toBe(null);
    });
  });
});

describe("estimateTokensFromChars", () => {
  it("estimates 1 token per 4 characters", () => {
    expect(estimateTokensFromChars("1234")).toBe(1);
    expect(estimateTokensFromChars("12345678")).toBe(2);
  });

  it("rounds up for partial tokens", () => {
    expect(estimateTokensFromChars("12345")).toBe(2); // 5/4 = 1.25 -> 2
    expect(estimateTokensFromChars("123")).toBe(1); // 3/4 = 0.75 -> 1
  });

  it("handles empty string", () => {
    expect(estimateTokensFromChars("")).toBe(0);
  });

  it("handles long text", () => {
    const longText = "a".repeat(1000);
    expect(estimateTokensFromChars(longText)).toBe(250);
  });
});

describe("isFetchConnectionFailure", () => {
  it("returns true for a Node fetch-failed TypeError", () => {
    const err = new TypeError("fetch failed");
    expect(isFetchConnectionFailure(err)).toBe(true);
  });

  it("is case-insensitive on the message", () => {
    const err = new TypeError("Fetch failed");
    expect(isFetchConnectionFailure(err)).toBe(true);
  });

  it("returns false for unrelated TypeErrors", () => {
    expect(isFetchConnectionFailure(new TypeError("oops"))).toBe(false);
  });

  it("returns false for plain Errors with the same message", () => {
    // Only undici raises this as a TypeError; a normal Error of the same
    // text is something else (e.g. user code) and should still warn.
    expect(isFetchConnectionFailure(new Error("fetch failed"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isFetchConnectionFailure("fetch failed")).toBe(false);
    expect(isFetchConnectionFailure(undefined)).toBe(false);
    expect(isFetchConnectionFailure(null)).toBe(false);
  });
});

describe("getFetchErrorCause", () => {
  it("extracts cause.code from a fetch-failed TypeError", () => {
    const err = new TypeError("fetch failed");
    (err as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
    expect(getFetchErrorCause(err)).toBe("ECONNREFUSED");
  });

  it("returns undefined when cause is missing", () => {
    expect(getFetchErrorCause(new TypeError("fetch failed"))).toBeUndefined();
  });

  it("returns undefined when cause.code is not a string", () => {
    const err = new TypeError("fetch failed");
    (err as { cause?: unknown }).cause = { code: 42 };
    expect(getFetchErrorCause(err)).toBeUndefined();
  });

  it("handles non-object errors gracefully", () => {
    expect(getFetchErrorCause("nope")).toBeUndefined();
    expect(getFetchErrorCause(null)).toBeUndefined();
    expect(getFetchErrorCause(undefined)).toBeUndefined();
  });
});

describe("countToolsTokens fallback behavior", () => {
  const originalFetch = global.fetch;
  const originalUrl = process.env.CONVEX_HTTP_URL;

  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "http://nowhere.invalid";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalUrl === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = originalUrl;
    }
    vi.restoreAllMocks();
  });

  it("returns a char-based estimate (not 0) when fetch throws a connection error", async () => {
    // Simulate the undici 'fetch failed' shape that fires on DNS/ECONNREFUSED/TLS.
    global.fetch = vi.fn().mockImplementation(() => {
      const err = new TypeError("fetch failed");
      (err as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
      throw err;
    });

    const tools = [{ name: "search", description: "search the catalog" }];
    const expected = estimateTokensFromChars(JSON.stringify(tools));

    const result = await countToolsTokens(tools, "claude-opus-4-1");

    expect(expected).toBeGreaterThan(0); // sanity
    expect(result).toBe(expected);
  });

  it("returns 0 only when the input itself cannot be serialized", async () => {
    // Circular reference -> JSON.stringify throws inside the try block before
    // fetch is reached. Spy on fetch to lock in that contract.
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof global.fetch;

    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const result = await countToolsTokens([circular], "claude-opus-4-1");

    expect(result).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
