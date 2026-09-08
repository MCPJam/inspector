import { describe, expect, it } from "vitest";
import {
  RUN_ORIGINS,
  RUN_ORIGIN_FILTERS,
  RUN_ORIGIN_META,
  maskApiKeyId,
  resolveRunOrigin,
  resolveRunProvenance,
  toQueryOrigins,
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

  it("offers a chip for EVERY origin it can badge", () => {
    // The invariant, not a list: an origin that can appear on a row and not in
    // the chip row is a label the reader can see and cannot act on, which is
    // the complaint this module exists to answer.
    expect([...RUN_ORIGIN_FILTERS].sort()).toEqual([...RUN_ORIGINS].sort());
  });

  it("reports WHICH layer answered, not just what it answered", () => {
    // The same origin arrives by different routes, and the badge has to be
    // able to tell them apart: `github` is stamped for a PR check and declared
    // for an Action, `mcp` is verified for a credentialled agent and declared
    // for anything that just says so.
    expect(resolveRunProvenance({ source: "github_check" })).toEqual({
      origin: "github",
      tier: "stamped",
    });
    expect(
      resolveRunProvenance({
        source: "api",
        launcher: { kind: "github_action" },
      }),
    ).toEqual({ origin: "github", tier: "declared" });
    expect(
      resolveRunProvenance({ source: "api", launcher: { kind: "mcp" } }),
    ).toEqual({ origin: "mcp", tier: "declared" });
    expect(
      resolveRunProvenance({
        source: "api",
        launcher: { kind: "cli" },
        attribution: { surface: "mcp" },
      }),
    ).toEqual({ origin: "mcp", tier: "verified" });
  });

  it("treats a prototype-named value as unrecognized, not as a hit", () => {
    // These strings come off the wire. Looked up in a plain object they answer
    // with something inherited and truthy, and the badge would then index its
    // label table with a function — one bad row taking out the whole table.
    for (const hostile of ["constructor", "toString", "__proto__", "valueOf"]) {
      expect(resolveRunOrigin({ source: hostile })).toBe("ui");
      expect(
        resolveRunOrigin({ source: "api", launcher: { kind: hostile } }),
      ).toBe("api");
      expect(
        resolveRunOrigin({ source: "api", attribution: { surface: hostile } }),
      ).toBe("api");
      // The label table is the thing that would have blown up.
      expect(
        RUN_ORIGIN_META[resolveRunOrigin({ source: hostile })],
      ).toBeTruthy();
    }
  });
});

/**
 * The wire contract. The chips are the reader's vocabulary; `listProjectRuns`
 * validates against the STORED one, and a value it does not know fails the
 * whole query rather than the one filter — a blank Runs table, not a blank
 * chip.
 */
describe("toQueryOrigins", () => {
  /**
   * `convex/lib/runLauncher.ts`'s `runOriginValidator`, copied deliberately.
   *
   * A copy, because the client cannot import from the backend: the point is to
   * fail HERE, in a fast unit test, the moment the two vocabularies drift —
   * rather than in production, on the one chip nobody clicked before deploy.
   */
  const BACKEND_ORIGINS = [
    "ui",
    "sdk",
    "api",
    "schedule",
    "github_check",
    "cli",
    "mcp",
    "github_action",
    "slack",
    "discord",
  ];

  it("only ever emits values the backend validator accepts", () => {
    // The invariant that matters, checked across every chip at once.
    for (const origin of RUN_ORIGIN_FILTERS) {
      for (const value of toQueryOrigins([origin])) {
        expect(BACKEND_ORIGINS, `${origin} → ${value}`).toContain(value);
      }
    }
  });

  it("expands the one chip that stands for two stored values", () => {
    // GitHub reaches a row two ways — declared by the Action, stamped by the
    // check — and "GitHub" means both to the person clicking it.
    expect(toQueryOrigins(["github"])).toEqual([
      "github_action",
      "github_check",
    ]);
  });

  it("passes the origins that need no translation straight through", () => {
    expect(toQueryOrigins(["cli"])).toEqual(["cli"]);
    expect(toQueryOrigins(["api"])).toEqual(["api"]);
    expect(toQueryOrigins(["slack"])).toEqual(["slack"]);
  });

  it("asks for `mcp` once, though it is both a verified surface and a launcher", () => {
    expect(toQueryOrigins(["mcp"])).toEqual(["mcp"]);
  });

  it("is stable in order, so one selection is one query", () => {
    // `usePaginatedQuery` keys on its arguments: an order that wobbled between
    // renders would silently reset the pagination the table is holding.
    expect(toQueryOrigins(["sdk", "github"])).toEqual(
      toQueryOrigins(["github", "sdk"]),
    );
  });

  it("leaves an empty selection empty", () => {
    // The caller sends `undefined` rather than `[]`; this just must not invent
    // a filter of its own.
    expect(toQueryOrigins([])).toEqual([]);
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
