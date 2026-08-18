import { describe, expect, it } from "vitest";
import {
  classifyScenarioAccessError,
  classifyScenarioAccessResponse,
  patchBodyAccessVersion,
} from "@/lib/scenario-access-errors";

describe("classifyScenarioAccessError", () => {
  it("classifies the stale and denied codes off a top-level `code`", () => {
    expect(
      classifyScenarioAccessError(409, {
        code: "SCENARIO_ACCESS_STALE",
        message: "Scenario access version is stale; re-redeem.",
      })
    ).toEqual({
      kind: "stale",
      status: 409,
      code: "SCENARIO_ACCESS_STALE",
      message: "Scenario access version is stale; re-redeem.",
    });

    expect(
      classifyScenarioAccessError(403, {
        code: "SCENARIO_ACCESS_DENIED",
        message: "nope",
      })?.kind
    ).toBe("denied");
  });

  it("prefers the domain code in `details.code` over the transport code", () => {
    // Same precedence readRouteError uses: the transport code says the shape
    // of the failure, the domain code says why.
    const info = classifyScenarioAccessError(409, {
      code: "CONFLICT",
      details: { code: "SCENARIO_ACCESS_STALE" },
      message: "stale",
    });
    expect(info).toMatchObject({ kind: "stale", code: "SCENARIO_ACCESS_STALE" });
  });

  it("reads the message from `error` when the envelope has no `message`", () => {
    // The mcp chat-v2 route hand-rolls `{ error, code }`.
    expect(
      classifyScenarioAccessError(403, {
        error: "Couldn't load this scenario's settings, so the turn was stopped.",
        code: "SCENARIO_ACCESS_DENIED",
      })?.message
    ).toContain("Couldn't load this scenario's settings");
  });

  it("falls back to the legacy 403 INTERNAL_ERROR fail-closed envelope", () => {
    // Deploy skew: a server that predates the codes still fails closed with
    // this exact authored prefix.
    expect(
      classifyScenarioAccessError(403, {
        code: "INTERNAL_ERROR",
        message:
          "Couldn't load this scenario's settings, so the turn was stopped to avoid running with the wrong configuration. Scenario not found or access denied",
      })?.kind
    ).toBe("denied");
  });

  it("does NOT claim a bare 403 — an OAuth insufficient_scope challenge is not an access verdict", () => {
    expect(
      classifyScenarioAccessError(403, {
        code: "FORBIDDEN",
        message: "insufficient_scope",
      })
    ).toBeNull();

    // Same message, wrong status: the legacy fallback is status-pinned too.
    expect(
      classifyScenarioAccessError(500, {
        code: "INTERNAL_ERROR",
        message: "Couldn't load this scenario's settings, so the turn ...",
      })
    ).toBeNull();

    // Right code, wrong message: not the fail-closed branch.
    expect(
      classifyScenarioAccessError(403, {
        code: "INTERNAL_ERROR",
        message: "Something else went wrong",
      })
    ).toBeNull();
  });

  it("returns null for non-object bodies", () => {
    expect(classifyScenarioAccessError(403, null)).toBeNull();
    expect(classifyScenarioAccessError(403, "denied")).toBeNull();
    expect(classifyScenarioAccessError(403, undefined)).toBeNull();
  });
});

describe("classifyScenarioAccessResponse", () => {
  it("classifies without consuming the response body", async () => {
    const response = new Response(
      JSON.stringify({ code: "SCENARIO_ACCESS_STALE", message: "stale" }),
      { status: 409, headers: { "Content-Type": "application/json" } }
    );

    expect((await classifyScenarioAccessResponse(response))?.kind).toBe("stale");
    // The caller still owns an unread body — it may need to hand this exact
    // response back to the stream parser.
    expect(response.bodyUsed).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      code: "SCENARIO_ACCESS_STALE",
    });
  });

  it("returns null for a non-JSON body instead of throwing", async () => {
    const response = new Response("<html>gateway timeout</html>", {
      status: 504,
    });
    await expect(classifyScenarioAccessResponse(response)).resolves.toBeNull();
  });
});

describe("patchBodyAccessVersion", () => {
  it("replaces accessVersion and preserves every other field", () => {
    const body = JSON.stringify({
      scenarioId: "cbx_1",
      accessVersion: 3,
      messages: [{ role: "user", content: "hi" }],
    });

    const patched = JSON.parse(patchBodyAccessVersion(body, 7));
    expect(patched.accessVersion).toBe(7);
    expect(patched.scenarioId).toBe("cbx_1");
    expect(patched.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("adds accessVersion when the body did not carry one", () => {
    expect(
      JSON.parse(patchBodyAccessVersion(JSON.stringify({ a: 1 }), 2))
    ).toEqual({ a: 1, accessVersion: 2 });
  });

  it("returns the input untouched when it is not a JSON object", () => {
    // A replay with the old version still beats no replay at all.
    expect(patchBodyAccessVersion("not json", 2)).toBe("not json");
    expect(patchBodyAccessVersion("[1,2]", 2)).toBe("[1,2]");
    expect(patchBodyAccessVersion("null", 2)).toBe("null");
  });
});
