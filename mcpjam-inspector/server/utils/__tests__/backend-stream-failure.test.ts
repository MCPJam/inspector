import { describe, it, expect } from "vitest";
import { originOf } from "@mcpjam/sdk";
import {
  describeBackendStreamFailure,
  describeStreamErrorChunkFailure,
  isMcpjamOwnedFailureCode,
  isUserOwnedDenialCode,
  parseStreamErrorChunkText,
} from "../mcpjam-stream-handler.js";

describe("describeBackendStreamFailure", () => {
  it("owns a 5xx from MCPJam's own backend", () => {
    // The reported bug: a chat turn dying on a hosted 502. There is no Error
    // object at this site — only a non-OK Response — so nothing in the
    // describer can reach it, and before this the user got a raw string with
    // no way to tell our outage from their server's.
    const normalized = describeBackendStreamFailure(502, "Bad Gateway");

    expect(originOf(normalized)).toBe("mcpjam");
  });

  it.each([500, 503, 504])("owns a %i the same way", (status) => {
    expect(originOf(describeBackendStreamFailure(status, "boom"))).toBe("mcpjam");
  });

  it.each([401, 403])(
    "reads a bare %i as a user-owned credential wall",
    (status) => {
      const normalized = describeBackendStreamFailure(status, "invalid api key");

      expect(normalized.slug).toBe("provider/auth_error");
      // With no MCPJam-owned code on the body, a 401 from `/stream` is its own
      // auth gate (`auth_required` — sign in), which the user owns.
      expect(originOf(normalized)).toBe("user_config");
    },
  );

  it("reads a bare 429 as a quota wall", () => {
    const normalized = describeBackendStreamFailure(429, "rate limited");

    expect(normalized.slug).toBe("provider/quota");
    expect(originOf(normalized)).toBe("user_config");
  });

  // The regression this change exists for. `categorizeError` in the backend
  // mirrors the UPSTREAM provider's status onto our own response, so MCPJam's
  // revoked managed key arrives as a 401 and MCPJam's own quota as a 429 —
  // statuses whose catalog origin is `user_config`, which `mcpjam_internal`
  // refuses to promote. A total hosted outage was filed as the user's problem.
  it.each([
    [401, "mcpjam_api_error"],
    [403, "mcpjam_api_error"],
    [429, "mcpjam_rate_limit"],
    [500, "mcpjam_config_error"],
    // Also at 200: the spend-precheck shape is a 200 JSON denial, and an
    // MCPJam-owned code can ride the same envelope.
    [200, "mcpjam_api_error"],
  ])("owns a %i whose body names us via %s", (status, code) => {
    const normalized = describeBackendStreamFailure(status, "boom", code);

    expect(originOf(normalized)).toBe("mcpjam");
  });

  it("keeps the status-derived slug when the code names us", () => {
    // The user-facing copy stays accurate — the provider DID reject the key.
    // Only the ownership verdict changes: it was our key.
    const normalized = describeBackendStreamFailure(
      401,
      "boom",
      "mcpjam_api_error",
    );

    expect(normalized.slug).toBe("provider/auth_error");
  });

  it.each(["user_rate_limit", "auth_required", "invalid_request", undefined])(
    "leaves a %s body on the status verdict",
    (code) => {
      expect(originOf(describeBackendStreamFailure(401, "boom", code))).toBe(
        "user_config",
      );
    },
  );

  it("makes no claim about a 4xx it does not recognize", () => {
    const normalized = describeBackendStreamFailure(400, "bad request");

    expect(originOf(normalized)).toBe("ambiguous");
  });

  it("makes no claim when there is no status at all", () => {
    expect(originOf(describeBackendStreamFailure(undefined, "???"))).toBe(
      "ambiguous",
    );
  });

  it("keeps the status and body in the message for debugging", () => {
    const normalized = describeBackendStreamFailure(502, "upstream gone");

    expect(normalized.rawMessage).toContain("502");
    expect(normalized.rawMessage).toContain("upstream gone");
  });
});

describe("isUserOwnedDenialCode", () => {
  it.each(["user_rate_limit", "wallet_locked", "billing_limit_reached"])(
    "exempts the routine 200 denial %s from the internal boundary",
    (code) => {
      // These are the backend working correctly and refusing a request for a
      // user-owned reason. Declaring an internal boundary on them would page
      // the team on every ordinary spend-limit rejection.
      expect(isUserOwnedDenialCode(code)).toBe(true);
    },
  );

  it.each(["mcpjam_rate_limit", "mcpjam_api_error", "mcpjam_config_error"])(
    "does NOT exempt %s, which names US as the responsible party",
    (code) => {
      // The backend's error-code union includes these. A rule of "has any code
      // at all" would exempt precisely the failures most worth paging on.
      expect(isUserOwnedDenialCode(code)).toBe(false);
    },
  );

  it("does not exempt an unrecognized or absent code", () => {
    // An unknown code at HTTP 200 from OUR OWN backend is treated as a fault.
    // A missing entry here costs one investigated alert; the permissive rule
    // costs the blindness this work exists to remove.
    expect(isUserOwnedDenialCode("something_new")).toBe(false);
    expect(isUserOwnedDenialCode(undefined)).toBe(false);
  });
});

describe("describeStreamErrorChunkFailure", () => {
  it.each(["mcpjam_api_error", "mcpjam_rate_limit", "mcpjam_config_error"])(
    "owns a mid-stream failure whose code names us (%s)",
    (code) => {
      expect(
        originOf(describeStreamErrorChunkFailure(500, "boom", code)),
      ).toBe("mcpjam");
    },
  );

  // The whole reason this is a SEPARATE classifier. On the non-OK path the
  // status is our own backend's, so a 5xx is our outage. In an error CHUNK it
  // is the field the backend copied off the upstream provider's error, so an
  // Anthropic 503 arrives as `statusCode: 503`. Same number, opposite meaning.
  it.each([500, 502, 503, 529])(
    "does NOT claim a %i that came from the upstream provider",
    (status) => {
      expect(
        originOf(describeStreamErrorChunkFailure(status, "overloaded", "provider_error")),
      ).toBe("ambiguous");
    },
  );

  it("keeps the paired non-OK classifier owning the same status", () => {
    // Guards the split: if these two ever agree on a bare 503, one of them is
    // reading the status against its own delivery path.
    expect(originOf(describeBackendStreamFailure(503, "boom"))).toBe("mcpjam");
    expect(originOf(describeStreamErrorChunkFailure(503, "boom"))).toBe(
      "ambiguous",
    );
  });

  it("still reads a provider credential wall from the status", () => {
    const normalized = describeStreamErrorChunkFailure(401, "bad key");

    expect(normalized.slug).toBe("provider/auth_error");
    expect(originOf(normalized)).toBe("user_config");
  });
});

describe("parseStreamErrorChunkText", () => {
  it("reads the mid-stream shape, which uses `message` and an upstream status", () => {
    // NOT the `{ok, code, error, details}` shape of the non-OK path — this is
    // what `toUIMessageStreamResponse({onError})` serializes.
    const parsed = parseStreamErrorChunkText(
      JSON.stringify({
        code: "mcpjam_api_error",
        message: "MCPJam is experiencing a configuration issue.",
        statusCode: 401,
        isRetryable: false,
        details: "invalid api key",
      }),
    );

    expect(parsed).toEqual({
      code: "mcpjam_api_error",
      message: "MCPJam is experiencing a configuration issue.",
      statusCode: 401,
      details: "invalid api key",
    });
  });

  it("falls back to the raw text when the chunk is not JSON", () => {
    // Any other producer's error chunk — the text the client used to be
    // handed verbatim stays the display message.
    expect(parseStreamErrorChunkText("something broke")).toEqual({
      message: "something broke",
    });
  });

  it("falls back to the raw text when the JSON carries no usable message", () => {
    const raw = JSON.stringify({ code: "provider_error" });

    expect(parseStreamErrorChunkText(raw)).toEqual({
      message: raw,
      code: "provider_error",
    });
  });

  it("ignores non-string / non-number fields rather than trusting them", () => {
    const raw = JSON.stringify({ code: 7, message: "  ", statusCode: "503" });

    expect(parseStreamErrorChunkText(raw)).toEqual({ message: raw });
  });
});

describe("isMcpjamOwnedFailureCode", () => {
  it.each(["mcpjam_rate_limit", "mcpjam_api_error", "mcpjam_config_error"])(
    "claims %s, which the backend itself marks 'not user's fault'",
    (code) => {
      expect(isMcpjamOwnedFailureCode(code)).toBe(true);
    },
  );

  it.each([
    "user_rate_limit",
    "wallet_locked",
    "auth_required",
    "provider_rate_limit",
    "provider_error",
    "invalid_model",
  ])("does not claim the user- or provider-owned code %s", (code) => {
    expect(isMcpjamOwnedFailureCode(code)).toBe(false);
  });

  it("does not claim an unrecognized or absent code", () => {
    // Allowlist, not a `mcpjam_` prefix rule: a new backend code must be read
    // and classified rather than inheriting a page from its name.
    expect(isMcpjamOwnedFailureCode("mcpjam_something_new")).toBe(false);
    expect(isMcpjamOwnedFailureCode(undefined)).toBe(false);
  });

  it("is disjoint from the user-owned set", () => {
    const ours = ["mcpjam_rate_limit", "mcpjam_api_error", "mcpjam_config_error"];
    const theirs = ["user_rate_limit", "wallet_locked", "org_rate_limit"];
    for (const code of ours) {
      expect(isUserOwnedDenialCode(code)).toBe(false);
    }
    for (const code of theirs) {
      expect(isMcpjamOwnedFailureCode(code)).toBe(false);
    }
  });
});
