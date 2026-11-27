import { describe, expect, it } from "vitest";
import {
  OBSERVABLE_FEATURE_IDS,
  classifyFrame,
  requestContextOf,
} from "../classify-frame.js";
import { SERVER_FEATURE_CATALOG } from "../catalog/index.js";
import { APPS_BRIDGE_FEATURE_IDS } from "../classify-bridge.js";
import { FRAME_FIXTURES, SILENT_FRAMES } from "./frame-fixtures.js";

function sorted(ids: readonly string[]) {
  return [...ids].sort();
}

describe("classifyFrame", () => {
  it("derives the observable ids from the catalog", () => {
    expect(OBSERVABLE_FEATURE_IDS).toEqual(
      new Set(
        SERVER_FEATURE_CATALOG.filter(
          (entry) => entry.assessment.observable
        ).map((entry) => entry.id)
      )
    );
  });

  it.each(FRAME_FIXTURES.map((fixture) => [fixture.name, fixture] as const))(
    "%s",
    (_name, fixture) => {
      expect(
        sorted(
          classifyFrame(
            fixture.direction,
            fixture.message,
            fixture.era,
            fixture.request
          )
        )
      ).toEqual(sorted(fixture.expect));
    }
  );

  it.each(SILENT_FRAMES.map((fixture) => [fixture.name, fixture] as const))(
    "shows nothing for %s",
    (_name, fixture) => {
      expect(
        classifyFrame(
          fixture.direction,
          fixture.message,
          fixture.era,
          fixture.request
        )
      ).toEqual([]);
    }
  );

  it("emits only observable catalog ids", () => {
    for (const fixture of FRAME_FIXTURES) {
      for (const id of fixture.expect) {
        expect(OBSERVABLE_FEATURE_IDS.has(id), `${fixture.name}: ${id}`).toBe(
          true
        );
      }
    }
  });

  it("covers every observable id except the Apps bridge ones", () => {
    const emitted = new Set(
      FRAME_FIXTURES.flatMap((fixture) => fixture.expect)
    );
    const missing = [...OBSERVABLE_FEATURE_IDS].filter(
      (id) => !emitted.has(id) && !APPS_BRIDGE_FEATURE_IDS.has(id)
    );
    expect(missing).toEqual([]);
    for (const id of APPS_BRIDGE_FEATURE_IDS) {
      expect(OBSERVABLE_FEATURE_IDS.has(id), id).toBe(true);
      expect(emitted.has(id), id).toBe(false);
    }
  });

  it("returns ids, never payload strings", () => {
    const frame = FRAME_FIXTURES[0];
    const ids = classifyFrame(
      frame.direction,
      frame.message,
      frame.era,
      frame.request
    );
    const text = JSON.stringify(ids);
    for (const secret of ["secret text", "file:///private", "private"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("ignores content block types that are not MCP types", () => {
    expect(
      classifyFrame(
        "server-to-client",
        {
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "constructor" }] },
        },
        "legacy",
        { method: "tools/call" }
      )
    ).toEqual(["tool-results.content"]);
  });

  it("does not count the serverInfo key as result metadata", () => {
    const ids = classifyFrame(
      "server-to-client",
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [],
          _meta: { "io.modelcontextprotocol/serverInfo": { name: "srv" } },
        },
      },
      "modern",
      { method: "tools/call" }
    );
    expect(ids).not.toContain("tool-results.result-meta");
  });
});

describe("requestContextOf", () => {
  it("keeps the method and the completion reference kind only", () => {
    expect(
      requestContextOf({
        jsonrpc: "2.0",
        id: 1,
        method: "completion/complete",
        params: {
          ref: { type: "ref/prompt", name: "private" },
          argument: { name: "city", value: "Par" },
        },
      })
    ).toEqual({ method: "completion/complete", completionRef: "prompt" });
    expect(
      requestContextOf({
        jsonrpc: "2.0",
        id: 2,
        method: "completion/complete",
        params: { ref: { type: "ref/resource", uri: "file:///{x}" } },
      })
    ).toEqual({ method: "completion/complete", completionRef: "resource" });
    expect(
      requestContextOf({
        jsonrpc: "2.0",
        id: 3,
        method: "resources/read",
        params: { uri: "file:///private" },
      })
    ).toEqual({ method: "resources/read" });
  });

  it("returns nothing for responses", () => {
    expect(requestContextOf({ jsonrpc: "2.0", id: 1, result: {} })).toBe(
      undefined
    );
  });
});
