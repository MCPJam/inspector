import { describe, expect, it } from "vitest";
import { fullCoverage, makeSurface } from "../../../__tests__/fixtures.js";
import { declared, isGap, kindOf } from "./helpers.js";

describe("server information", () => {
  it("reads name, version and title from serverInfo", () => {
    const surface = makeSurface({
      serverInfo: { name: "weather", version: "1.2.0", title: "Weather" },
    });
    expect(kindOf(declared("server-info.name-version", surface))).toBe(
      "present"
    );
    expect(kindOf(declared("server-info.title", surface))).toBe("present");
  });

  it("calls a missing field a gap only when serverInfo was captured", () => {
    const complete = makeSurface();
    expect(isGap(declared("server-info.icons", complete), complete)).toBe(true);
    expect(
      isGap(declared("server-info.instructions", complete), complete)
    ).toBe(true);

    const dropped = makeSurface({
      coverage: fullCoverage({
        serverInfo: "not-captured",
        instructions: "partial",
      }),
    });
    expect(isGap(declared("server-info.icons", dropped), dropped)).toBe(false);
    expect(isGap(declared("server-info.instructions", dropped), dropped)).toBe(
      false
    );
  });

  it("treats a missing name or version as absent, not supported", () => {
    const surface = makeSurface({ serverInfo: { name: "weather" } });
    expect(kindOf(declared("server-info.name-version", surface))).toBe(
      "absent"
    );
  });

  it("lists experimental capabilities and is not applicable without any", () => {
    const withKeys = makeSurface({
      capabilities: { experimental: { "acme/search": {} } },
    });
    expect(declared("server-info.experimental", withKeys)).toMatchObject({
      kind: "present",
      count: 1,
      detail: "acme/search",
    });
    expect(kindOf(declared("server-info.experimental", makeSurface()))).toBe(
      "not-applicable"
    );
    const partial = makeSurface({
      coverage: fullCoverage({ capabilities: "partial" }),
    });
    expect(isGap(declared("server-info.experimental", partial), partial)).toBe(
      false
    );
  });

  it("detects serverInfo in the discover result's _meta", () => {
    const surface = makeSurface({
      protocolVersion: "2026-07-28",
      discoveryMeta: {
        "io.modelcontextprotocol/serverInfo": { name: "weather", version: "1" },
      },
    });
    expect(kindOf(declared("server-info.result-server-info", surface))).toBe(
      "present"
    );
    expect(
      declared("server-info.result-server-info", makeSurface())
    ).toBeNull();
  });
});
