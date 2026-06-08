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

  it("collapses draft-only codes onto canonical equivalents", () => {
    expect(mapInternalCode("UPSTREAM_ERROR")).toBe("SERVER_UNREACHABLE");
    expect(mapInternalCode("TOOL_TIMEOUT")).toBe("TIMEOUT");
    expect(mapInternalCode("OAUTH_REQUIRED")).toBe("OAUTH_REQUIRED");
  });

  it("falls back to INTERNAL_ERROR for unknown codes", () => {
    expect(mapInternalCode("SOMETHING_NEW")).toBe("INTERNAL_ERROR");
    expect(mapInternalCode(undefined)).toBe("INTERNAL_ERROR");
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
