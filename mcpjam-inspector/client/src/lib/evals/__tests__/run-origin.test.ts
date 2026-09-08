import { describe, expect, it } from "vitest";
import {
  RUN_ORIGINS,
  RUN_ORIGIN_FILTERS,
  RUN_ORIGIN_META,
  maskApiKeyId,
  resolveRunOrigin,
} from "../run-origin";

/**
 * The precedence, stated as tests, because each tier exists to fix a specific
 * way the old single-field rule was wrong.
 */
describe("resolveRunOrigin", () => {
  it("reads the stamped source when nothing outranks it", () => {
    expect(resolveRunOrigin({ source: "ui" })).toBe("ui");
    expect(resolveRunOrigin({ source: "sdk" })).toBe("sdk");
    expect(resolveRunOrigin({ source: "api" })).toBe("api");
    expect(resolveRunOrigin({ source: "schedule" })).toBe("schedule");
    expect(resolveRunOrigin({ source: "github_check" })).toBe("github");
  });

  it("falls back to ui for a row that predates every column", () => {
    // The same fallback `getRunMetricSource` and the backend's projections use,
    // so a legacy run reads identically everywhere.
    expect(resolveRunOrigin({})).toBe("ui");
    expect(resolveRunOrigin({ source: null })).toBe("ui");
    expect(resolveRunOrigin({ source: "something_new" })).toBe("ui");
  });

  it("lets a declared launcher outrank the coarse stamp", () => {
    // The reason the whole thing exists: all three of these are honestly
    // `source: "api"`, and saying so is true and useless.
    expect(resolveRunOrigin({ source: "api", launcher: { kind: "cli" } })).toBe(
      "cli",
    );
    expect(resolveRunOrigin({ source: "api", launcher: { kind: "mcp" } })).toBe(
      "mcp",
    );
    expect(
      resolveRunOrigin({ source: "api", launcher: { kind: "github_action" } }),
    ).toBe("github");
  });

  it("lets a VERIFIED channel outrank a declared one", () => {
    expect(
      resolveRunOrigin({
        source: "api",
        launcher: { kind: "cli" },
        attribution: { surface: "mcp" },
      }),
    ).toBe("mcp");
  });

  it("does not let a plain REST credential outrank anything", () => {
    // `rest` is what an ordinary API call mints, so EVERY CLI run carries one.
    // Treating it as a verified origin would collapse the feature back to
    // "everything is API".
    expect(
      resolveRunOrigin({
        source: "api",
        launcher: { kind: "cli" },
        attribution: { surface: "rest" },
      }),
    ).toBe("cli");
    // Same for `cli` and `workspace`: they say nothing the declared label and
    // the stamp do not already say better.
    expect(
      resolveRunOrigin({
        source: "api",
        launcher: { kind: "github_action" },
        attribution: { surface: "cli" },
      }),
    ).toBe("github");
  });

  it("ignores a launcher kind it does not recognize", () => {
    // Deploy skew, or a client inventing one. The stamp is still true.
    expect(
      resolveRunOrigin({ source: "api", launcher: { kind: "carrier_pigeon" } }),
    ).toBe("api");
  });
});

describe("the origin vocabulary", () => {
  it("has a label for every origin, so nothing can resolve to a blank badge", () => {
    for (const origin of RUN_ORIGINS) {
      expect(RUN_ORIGIN_META[origin]?.label, origin).toBeTruthy();
      expect(RUN_ORIGIN_META[origin]?.title, origin).toBeTruthy();
    }
  });

  it("offers a chip for every origin a client can produce, and no others", () => {
    // `slack` and `discord` exist only when a verified credential says so —
    // nothing can declare them — so a chip for either could never match.
    expect([...RUN_ORIGIN_FILTERS].sort()).toEqual(
      ["api", "cli", "github", "mcp", "schedule", "sdk", "ui"].sort(),
    );
  });

  it("marks exactly the self-reported origins as declared", () => {
    expect(RUN_ORIGIN_META.cli.declared).toBe(true);
    expect(RUN_ORIGIN_META.mcp.declared).toBe(true);
    // `github` is reachable BOTH ways (a PR check stamps it, an Action declares
    // it), so it is not marked declared: the badge would then promise "the
    // client told us" about a run the server stamped itself.
    expect(RUN_ORIGIN_META.github.declared).toBe(false);
    expect(RUN_ORIGIN_META.api.declared).toBe(false);
  });
});

describe("maskApiKeyId", () => {
  it("shows the last four and nothing else", () => {
    // Enough to answer "which of my keys?", not enough to paste into a search.
    expect(maskApiKeyId("key_live_abcd1234")).toBe("····1234");
  });

  it("returns null rather than an empty mask", () => {
    expect(maskApiKeyId(undefined)).toBeNull();
    expect(maskApiKeyId(null)).toBeNull();
    expect(maskApiKeyId("   ")).toBeNull();
  });
});
