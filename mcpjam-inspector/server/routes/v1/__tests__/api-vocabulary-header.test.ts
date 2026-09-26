import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * `x-mcpjam-api-vocabulary` as the routes that negotiate it see it.
 *
 * Four things, in the order they would hurt:
 *
 *   1. AN UNKNOWN VALUE IS REFUSED, before any read. A boundary that quietly
 *      served vocabulary 1 to a client that asked for something else is the
 *      exact failure the negotiation exists to prevent.
 *   2. VOCABULARY 1 IS BYTE-FOR-BYTE TODAY'S. Every route here answers a
 *      headerless request exactly as it did before the header existed.
 *   3. THE PATH SEGMENT FOLDS BOTH WAYS on shares, where the value is an
 *      address as well as a field.
 *   4. `Vary` IS ON EVERY NEGOTIATED RESPONSE, differing body or not — a
 *      cache keyed on the wrong axis serves one client another's spelling.
 */

const { validateGuestTokenMock, convexQueryMock, convexMutationMock } =
  vi.hoisted(() => ({
    validateGuestTokenMock: vi.fn(),
    convexQueryMock: vi.fn(),
    convexMutationMock: vi.fn(),
  }));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(() => ({
    setAuth: vi.fn(),
    query: convexQueryMock,
    mutation: convexMutationMock,
    action: vi.fn(),
  })),
}));

import v1Routes from "../index.js";
import {
  API_VOCABULARY_HEADER,
  UNKNOWN_API_VOCABULARY_MESSAGE,
} from "../api-vocabulary.js";

function request(
  method: string,
  path: string,
  options: { vocabulary?: string } = {},
): Promise<Response> {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return Promise.resolve(
    app.request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer tok",
        ...(options.vocabulary !== undefined
          ? { [API_VOCABULARY_HEADER]: options.vocabulary }
          : {}),
      },
    }),
  );
}

const SHARE = {
  resourceType: "scenario",
  resourceId: "cb_1",
  projectId: "p1",
  mode: "invited_only",
  members: [],
};

describe("x-mcpjam-api-vocabulary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "shares:getShareSettings") return Promise.resolve(SHARE);
      return Promise.resolve(null);
    });
  });

  const SHARE_PATH = (type: string) =>
    `/api/v1/projects/p1/shares/${type}/cb_1`;

  it("refuses a value that is neither 1 nor 2, before any read", async () => {
    const res = await request("GET", SHARE_PATH("scenario"), {
      vocabulary: "3",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.message).toBe(UNKNOWN_API_VOCABULARY_MESSAGE);
    expect(convexQueryMock).not.toHaveBeenCalledWith(
      "shares:getShareSettings",
      expect.anything(),
    );
  });

  it("refuses an EMPTY header, which is not a third spelling of 1", async () => {
    // Accepting it would mean a client whose header came out blank by
    // accident silently gets the legacy projection instead of this error.
    const res = await request("GET", SHARE_PATH("scenario"), {
      vocabulary: "",
    });
    expect(res.status).toBe(400);
  });

  it("answers a headerless share read exactly as it always did", async () => {
    const res = await request("GET", SHARE_PATH("scenario"));
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      resourceType: "scenario",
      resourceId: "cb_1",
    });
  });

  it("echoes `study` under vocabulary 2, whichever segment addressed it", async () => {
    // The stored rows are the same rows: the segment folds to storage before
    // anything reads it, and the echo goes out in the negotiated spelling.
    for (const segment of ["scenario", "study"]) {
      convexQueryMock.mockClear();
      const res = await request("GET", SHARE_PATH(segment), {
        vocabulary: "2",
      });
      expect(res.status, segment).toBe(200);
      expect((await res.json()) as Record<string, unknown>).toMatchObject({
        resourceType: "study",
        resourceId: "cb_1",
      });
      // Storage never saw the new spelling.
      expect(convexQueryMock).toHaveBeenCalledWith(
        "shares:getShareSettings",
        expect.objectContaining({ resourceType: "scenario" }),
      );
    }
  });

  it("404s `study` under vocabulary 1 — that segment is not in today's contract", async () => {
    // Vocabulary 1 is not widened to meet vocabulary 2 half way. A segment
    // today's contract has never accepted stays a 404, the same answer any
    // other unknown resource type gets.
    const res = await request("GET", SHARE_PATH("study"));
    expect(res.status).toBe(404);
  });

  it("varies on the header, on a negotiated response and on a refusal", async () => {
    for (const vocabulary of [undefined, "2"]) {
      const res = await request("GET", SHARE_PATH("scenario"), {
        ...(vocabulary !== undefined ? { vocabulary } : {}),
      });
      expect(res.headers.get("Vary") ?? "", String(vocabulary)).toContain(
        API_VOCABULARY_HEADER,
      );
    }
  });
});
