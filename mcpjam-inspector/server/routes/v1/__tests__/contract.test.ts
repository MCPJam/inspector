import { describe, it, expect } from "vitest";

import {
  V1_ERROR_CODES,
  V1_ERROR_STATUS,
  INTERNAL_TO_V1_CODE,
  isV1ErrorCode,
  mapInternalCode,
  classifyRuntimeError,
  v1ErrorBody,
  v1Page,
} from "../contract.js";

import errorCodesFixture from "../__fixtures__/error-codes.json";
import errorStatusFixture from "../__fixtures__/error-status.json";
import internalToV1Fixture from "../__fixtures__/internal-to-v1-code.json";
import envelopes from "../__fixtures__/envelopes.json";

import { ErrorCode } from "../../web/errors.js";

// Mirrors mcpjam-backend/convex/publicApi/__tests__/contract.test.ts against
// byte-identical golden fixtures. If the two public surfaces drift, both
// suites fail. Additionally asserts the existing Inspector ErrorCode union
// reconciles cleanly into the public v1 union.

describe("v1 error-code union", () => {
  it("matches the golden fixture exactly (order included)", () => {
    expect([...V1_ERROR_CODES]).toEqual(errorCodesFixture);
  });

  it("recognizes every fixture code via isV1ErrorCode", () => {
    for (const code of errorCodesFixture) {
      expect(isV1ErrorCode(code)).toBe(true);
    }
    expect(isV1ErrorCode("NOT_A_CODE")).toBe(false);
  });
});

describe("v1 error -> HTTP status mapping", () => {
  it("matches the golden fixture", () => {
    expect(V1_ERROR_STATUS).toEqual(errorStatusFixture);
  });
});

describe("internal-code -> public-code mapping", () => {
  it("matches the golden fixture", () => {
    expect(INTERNAL_TO_V1_CODE).toEqual(internalToV1Fixture);
  });

  it("maps every internal code onto a valid public code", () => {
    for (const value of Object.values(INTERNAL_TO_V1_CODE)) {
      expect(isV1ErrorCode(value)).toBe(true);
    }
  });

  it("reconciles every shipped Inspector ErrorCode into the public union", () => {
    for (const code of Object.values(ErrorCode)) {
      expect(isV1ErrorCode(mapInternalCode(code))).toBe(true);
    }
  });

  // The assertion above passes for an UNMAPPED code too: `mapInternalCode`
  // defaults to INTERNAL_ERROR, which is a perfectly valid public code. That
  // vacuum is how ENVIRONMENT_REVISION_CONFLICT once reached API callers as a
  // 500, and how UPSTREAM_AUTH_FAILED shipped internally while the public
  // surface kept reporting the user's own MCP server as an MCPJam fault.
  //
  // So pin the gap explicitly instead. Every internal code either has a public
  // mapping or is listed here as a known, accepted 500 — adding a new
  // ErrorCode without deciding fails this test rather than silently widening
  // the INTERNAL_ERROR bucket on the public API.
  const KNOWINGLY_UNMAPPED: readonly string[] = [
    // Hosted-surface concepts. Reachability from `/api/v1` is unconfirmed, so
    // they are left unmapped rather than guessed at.
    "XAA_CONNECTION_NOT_CONFIGURED",
    "TASK_NOT_FOUND",
    "TASKS_UNSUPPORTED",
    "SCENARIO_ACCESS_DENIED",
    "SCENARIO_ACCESS_STALE",
  ];

  it("has no UNDECIDED internal code silently collapsing to INTERNAL_ERROR", () => {
    const unmapped = Object.values(ErrorCode).filter(
      (code) => !Object.prototype.hasOwnProperty.call(INTERNAL_TO_V1_CODE, code)
    );

    expect([...unmapped].sort()).toEqual([...KNOWINGLY_UNMAPPED].sort());
  });

  it("maps an exhausted billing allowance onto FORBIDDEN, never INTERNAL_ERROR", () => {
    // Same reasoning as the upstream-auth case below, and the same failure it
    // prevents. `launch-journey-run` turns an upstream 402 into this code, and
    // with no mapping it collapsed to a 500 — so an organization out of credit
    // was reported to the caller as an MCPJam fault AND paged the on-call, for
    // a state only the customer can resolve. 403 is the honest answer: the key
    // is valid, this account may not do this right now, and retrying will not
    // help by itself.
    expect(mapInternalCode(ErrorCode.BILLING_LIMIT_REACHED)).toBe("FORBIDDEN");
    expect(mapInternalCode(ErrorCode.BILLING_LIMIT_REACHED)).not.toBe(
      "INTERNAL_ERROR"
    );
  });

  it("maps an upstream auth rejection onto FORBIDDEN, never INTERNAL_ERROR", () => {
    // The public twin of the hosted fix: the target server refused OUR
    // credentials, so an API caller must not be told MCPJam broke.
    expect(mapInternalCode(ErrorCode.UPSTREAM_AUTH_FAILED)).toBe("FORBIDDEN");
    expect(mapInternalCode(ErrorCode.UPSTREAM_AUTH_FAILED)).not.toBe(
      "INTERNAL_ERROR"
    );
  });

  it("collapses draft-only codes onto canonical equivalents", () => {
    expect(mapInternalCode("UPSTREAM_ERROR")).toBe("SERVER_UNREACHABLE");
    expect(mapInternalCode("TOOL_TIMEOUT")).toBe("TIMEOUT");
    expect(mapInternalCode("OAUTH_REQUIRED")).toBe("OAUTH_REQUIRED");
  });

  it("falls back to INTERNAL_ERROR for unknown codes", () => {
    expect(mapInternalCode("SOMETHING_NEW")).toBe("INTERNAL_ERROR");
    expect(mapInternalCode(undefined)).toBe("INTERNAL_ERROR");
    // Inherited Object.prototype keys must not leak through.
    expect(mapInternalCode("toString")).toBe("INTERNAL_ERROR");
    expect(mapInternalCode("hasOwnProperty")).toBe("INTERNAL_ERROR");
  });
});

describe("error envelope shape", () => {
  it("includes details when present", () => {
    expect(
      v1ErrorBody("NOT_FOUND", "Project not found", { projectId: "p_123" })
    ).toEqual(envelopes.error);
  });

  it("omits an empty details bag", () => {
    expect(
      v1ErrorBody("UNAUTHORIZED", "Missing or invalid bearer token")
    ).toEqual(envelopes.errorNoDetails);
    expect(
      v1ErrorBody("UNAUTHORIZED", "Missing or invalid bearer token", {})
    ).toEqual(envelopes.errorNoDetails);
  });
});

describe("pagination envelope shape", () => {
  it("includes nextCursor when present", () => {
    expect(v1Page([{ id: "a" }, { id: "b" }], "1700000000000")).toEqual(
      envelopes.page
    );
  });

  it("omits nextCursor when absent", () => {
    expect(v1Page([{ id: "a" }])).toEqual(envelopes.pageNoCursor);
  });

  it("keeps an empty-string nextCursor instead of dropping it", () => {
    // For the MCP-backed routes (/tools, /prompts, /resources) this value is a
    // passthrough of the MCP server's own cursor, and MCP 2026-07-28
    // `server/utilities/pagination` says "an empty string is a valid cursor
    // and thus MUST NOT be treated as the end of results". A truthiness test
    // here stripped it and told the caller the listing had ended.
    expect(v1Page([{ id: "a" }], "")).toEqual({
      items: [{ id: "a" }],
      nextCursor: "",
    });
    expect("nextCursor" in v1Page([{ id: "a" }], "")).toBe(true);
  });
});

describe("runtime error classification", () => {
  it("buckets timeouts and connection failures, not the word reconnect", () => {
    expect(classifyRuntimeError(new Error("request timed out")).code).toBe(
      "TIMEOUT"
    );
    expect(classifyRuntimeError(new Error("fetch failed")).code).toBe(
      "SERVER_UNREACHABLE"
    );
    expect(
      classifyRuntimeError(new Error("Reconnect the missing server")).code
    ).toBe("INTERNAL_ERROR");
  });
});
