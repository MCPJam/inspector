import { describe, expect, it } from "vitest";
import {
  MAX_TOOLS_LIST_PAGES,
  walkToolsList,
  type RawHttpResult,
} from "../../src/mcp-conformance/raw-http.js";

/**
 * MCP 2026-07-28 / draft `server/utilities/pagination`:
 *
 *   "Clients MUST treat cursors as opaque tokens: ... Don't make any
 *    determination based on cursor value other than whether a non-null value
 *    was provided (e.g. an empty string is a valid cursor and thus MUST NOT be
 *    treated as the end of results)"
 *
 * `walkToolsList` used to stop on `nextCursor: ""`, which drops every tool on
 * page two onward and lets a check certify a listing it never finished reading.
 */

/** Minimal `RawHttpResult` carrying one JSON-RPC result document. */
function jsonResult(id: number, result: unknown): RawHttpResult {
  const body = JSON.stringify({ jsonrpc: "2.0", id, result });
  return {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    bodyText: body,
    json: JSON.parse(body),
    exchange: {} as RawHttpResult["exchange"],
  };
}

describe("walkToolsList — empty-string cursors (2026-07-28 pagination)", () => {
  it("follows a `nextCursor` of \"\" and sends it back verbatim", async () => {
    const seen: Array<string | undefined> = [];

    const walk = await walkToolsList({
      startId: 1,
      request: async ({ id, cursor }) => {
        seen.push(cursor);
        // Page one hands back the EMPTY-STRING cursor; page two ends the walk.
        return cursor === undefined
          ? jsonResult(id, { tools: [{ name: "page-1-tool" }], nextCursor: "" })
          : jsonResult(id, { tools: [{ name: "page-2-tool" }] });
      },
    });

    // (a) the walk continued past the `""` page ...
    expect(walk.tools.map((t) => t.name)).toEqual([
      "page-1-tool",
      "page-2-tool",
    ]);
    expect(walk.pagesRead).toBe(2);
    expect(walk.termination).toBe("complete");
    expect(walk.malformedPage).toBe(false);

    // (b) ... and the follow-up request actually carried `cursor: ""`.
    expect(seen).toEqual([undefined, ""]);
  });

  it("trips the repeated-cursor guard when a server loops on \"\"", async () => {
    const seen: Array<string | undefined> = [];

    const walk = await walkToolsList({
      startId: 1,
      request: async ({ id, cursor }) => {
        seen.push(cursor);
        return jsonResult(id, {
          tools: [{ name: `tool-${seen.length}` }],
          nextCursor: "",
        });
      },
    });

    // `""` participates in the seen-cursor set like any other token, so the
    // second occurrence stops the walk instead of spinning to the page cap.
    expect(walk.termination).toBe("repeated-cursor");
    expect(walk.pagesRead).toBe(2);
    expect(seen).toEqual([undefined, ""]);
    expect(walk.pagesRead).toBeLessThan(MAX_TOOLS_LIST_PAGES);
  });

  it("still ends the walk when `nextCursor` is absent or null", async () => {
    for (const page of [{ tools: [] }, { tools: [], nextCursor: null }]) {
      const walk = await walkToolsList({
        startId: 1,
        request: async ({ id }) => jsonResult(id, page),
      });
      expect(walk.termination).toBe("complete");
      expect(walk.pagesRead).toBe(1);
      expect(walk.malformedPage).toBe(false);
    }
  });

  it("still reports a non-string `nextCursor` as malformed, not as an ending", async () => {
    const walk = await walkToolsList({
      startId: 1,
      request: async ({ id }) => jsonResult(id, { tools: [], nextCursor: 42 }),
    });

    expect(walk.malformedPage).toBe(true);
    expect(walk.termination).not.toBe("complete");
  });
});
