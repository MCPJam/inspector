import { describe, expect, it } from "vitest";
import type { FeatureStateCounts } from "@mcpjam/sdk/browser";
import {
  FEATURE_STATE_META,
  formatStateCounts,
  needsNewerCause,
  rowStateLabels,
  stateBarSegments,
} from "../feature-states";
import {
  buildFeatureCards,
  filterFeatureCards,
  resolveFeatureSelection,
} from "../feature-tree";
import {
  SERVER_FEATURE_CATALOG,
  evaluate,
  neverConnectedEvaluation,
  storedEvidence,
} from "./fixtures";

function counts(partial: Partial<FeatureStateCounts>): FeatureStateCounts {
  return {
    "check-failed": 0,
    supported: 0,
    "needs-newer": 0,
    "could-add": 0,
    "not-checked": 0,
    "not-applicable": 0,
    ...partial,
  };
}

describe("formatStateCounts", () => {
  it("lists non-zero counts in a fixed order", () => {
    expect(
      formatStateCounts(
        counts({ "not-checked": 2, supported: 6, "could-add": 3 }),
      ),
    ).toBe("6 supported · 3 could add · 2 not checked");
  });

  it("adds needs newer and check failed only when non-zero", () => {
    expect(
      formatStateCounts(
        counts({ supported: 1, "needs-newer": 1, "check-failed": 2 }),
      ),
    ).toBe("1 supported · 1 needs newer · 2 checks failed");
    expect(formatStateCounts(counts({ "needs-newer": 3, "check-failed": 1 }))).toBe(
      "3 need newer · 1 check failed",
    );
  });

  it("falls back to not applicable, and to nothing for an empty set", () => {
    expect(formatStateCounts(counts({ "not-applicable": 4 }))).toBe(
      "4 not applicable",
    );
    expect(formatStateCounts(counts({}))).toBe("");
  });
});

describe("stateBarSegments", () => {
  it("splits the bar by the counts the text names, skipping zeros", () => {
    const partial = counts({
      supported: 3,
      "could-add": 1,
      "not-applicable": 4,
    });
    const segments = stateBarSegments(partial);
    expect(segments.map((segment) => [segment.state, segment.percent])).toEqual([
      ["supported", 75],
      ["could-add", 25],
    ]);
    // Same states as the text, which leaves not applicable out here.
    expect(formatStateCounts(partial)).toBe("3 supported · 1 could add");
  });

  it("fills the bar with not applicable when nothing else is counted", () => {
    expect(stateBarSegments(counts({ "not-applicable": 4 }))).toEqual([
      { state: "not-applicable", count: 4, percent: 100 },
    ]);
    expect(stateBarSegments(counts({}))).toEqual([]);
  });

  it("gives not applicable a fill that differs from the track", () => {
    expect(FEATURE_STATE_META["not-applicable"].barClass).not.toBe("bg-muted");
  });
});

describe("needs-newer labels", () => {
  const evaluation = evaluate(storedEvidence());
  const feature = (id: string) =>
    SERVER_FEATURE_CATALOG.find((entry) => entry.id === id)!;
  const causeOf = (id: string) =>
    needsNewerCause(feature(id), evaluation.assessments[id]);

  it("says which party a feature depends on, and keeps needs newer for versions", () => {
    expect(causeOf("client.sampling")).toBe("client");
    expect(causeOf("apps.host-notifications")).toBe("host");
    expect(causeOf("apps.view-requests")).toBe("host");
    expect(causeOf("auth-ext.xaa.token-exchange")).toBe("identity-provider");
    expect(evaluation.assessments["tasks.ext"].applicability).toBe("not-yet");
    expect(causeOf("tasks.ext")).toBe("version");
    expect(causeOf("tools.list")).toBeUndefined();
  });

  it("blames the client when a server feature needs an extension it did not advertise", () => {
    const withoutUi = evaluate(storedEvidence({ clientExtensions: [] }));
    expect(withoutUi.assessments["apps.ui-resource"]).toMatchObject({
      state: "needs-newer",
      applicability: "applies",
    });
    expect(
      needsNewerCause(feature("apps.ui-resource"), withoutUi.assessments["apps.ui-resource"]),
    ).toBe("client");
  });

  it("labels rows by cause and leaves other states and unknown causes alone", () => {
    expect(rowStateLabels("needs-newer", "client")).toEqual({
      label: "Depends on the client",
      shortLabel: "Depends on client",
    });
    expect(rowStateLabels("needs-newer", "host").shortLabel).toBe("Depends on host");
    expect(rowStateLabels("needs-newer", "version")).toEqual({
      label: "Needs a newer protocol version",
      shortLabel: "Needs newer",
    });
    expect(rowStateLabels("needs-newer")).toEqual({
      label: "Needs a newer version or client",
      shortLabel: "Needs newer",
    });
    expect(rowStateLabels("supported", "client").label).toBe("Supported");
  });

  it("gives a rolled-up parent its children's cause only when they agree", () => {
    const rowOf = (cards: ReturnType<typeof buildFeatureCards>, id: string) =>
      cards
        .flatMap((card) => card.families.flatMap((family) => family.rows))
        .find((row) => row.feature.id === id);
    const cards = buildFeatureCards(SERVER_FEATURE_CATALOG, evaluation);
    expect(rowOf(cards, "auth-ext.xaa")?.assessment).toMatchObject({
      state: "needs-newer",
      evidence: [],
    });
    expect(rowOf(cards, "auth-ext.xaa")?.needsNewer).toBe("identity-provider");
    expect(rowOf(cards, "auth-ext.client-credentials")?.needsNewer).toBe(
      "client",
    );
    expect(rowOf(cards, "client.sampling")?.needsNewer).toBe("client");
    expect(rowOf(cards, "tools.list")?.needsNewer).toBeUndefined();
    // Core authorization mixes newer-version leaves with client-side ones.
    expect(rowOf(cards, "auth.issuer-validation")?.needsNewer).toBe("version");
    expect(rowOf(cards, "auth.scope-selection")?.needsNewer).toBe("client");
    expect(rowOf(cards, "auth.oauth")?.assessment.state).toBe("needs-newer");
    expect(rowOf(cards, "auth.oauth")?.needsNewer).toBeUndefined();

    const saml = evaluation.assessments["auth-ext.xaa.saml"];
    const mixed = buildFeatureCards(SERVER_FEATURE_CATALOG, {
      ...evaluation,
      assessments: {
        ...evaluation.assessments,
        "auth-ext.xaa.saml": { ...saml, applicability: "not-yet" },
      },
    });
    expect(rowOf(mixed, "auth-ext.xaa.saml")?.needsNewer).toBe("version");
    expect(rowOf(mixed, "auth-ext.xaa")?.needsNewer).toBeUndefined();
  });
});

describe("buildFeatureCards", () => {
  const evaluation = evaluate(storedEvidence());
  const cards = buildFeatureCards(SERVER_FEATURE_CATALOG, evaluation);

  it("builds the eight spec cards with the evaluator's counts", () => {
    expect(cards.map((card) => card.id)).toEqual([
      "server-info",
      "base-protocol",
      "server-features",
      "server-utilities",
      "client-features",
      "authorization",
      "extensions",
      "third-party",
    ]);
    const serverFeatures = cards.find((card) => card.id === "server-features");
    expect(serverFeatures?.counts).toEqual(
      evaluation.cards.find((card) => card.id === "server-features")?.counts,
    );
    expect(cards.flatMap((card) => card.families)).toHaveLength(24);
  });

  it("puts every catalog entry in its family with its depth", () => {
    const rows = cards.flatMap((card) =>
      card.families.flatMap((family) => family.rows),
    );
    expect(rows).toHaveLength(SERVER_FEATURE_CATALOG.length);
    const byId = new Map(rows.map((row) => [row.feature.id, row]));
    expect(byId.get("tools.capability")?.depth).toBe(0);
    expect(byId.get("tools.list")?.depth).toBe(1);
    expect(byId.get("tools.list")?.assessment.state).toBe("supported");
  });
});

describe("filterFeatureCards", () => {
  const evaluation = evaluate(storedEvidence());
  const cards = buildFeatureCards(SERVER_FEATURE_CATALOG, evaluation);
  const parentIds = new Set(
    SERVER_FEATURE_CATALOG.map((feature) => feature.parent),
  );
  const leafCount = SERVER_FEATURE_CATALOG.filter(
    (feature) => !parentIds.has(feature.id),
  ).length;

  it("passes everything through when nothing narrows it", () => {
    const result = filterFeatureCards(cards, { query: "", filter: "all" });
    expect(result.active).toBe(false);
    expect(result.cards).toHaveLength(8);
    expect(result.matchCount).toBe(leafCount);
  });

  it("counts leaves only, so a state filter agrees with the card counts", () => {
    const states = [
      "could-add",
      "not-checked",
      "supported",
      "needs-newer",
      "check-failed",
    ] as const;
    for (const state of states) {
      const result = filterFeatureCards(cards, { query: "", filter: state });
      const cardTotal = cards.reduce((sum, card) => sum + card.counts[state], 0);
      expect(result.matchCount, state).toBe(cardTotal);
      expect(result.matchCount, state).toBe(evaluation.totals[state]);
    }
    const couldAdd = filterFeatureCards(cards, {
      query: "",
      filter: "could-add",
    });
    const shown = couldAdd.cards.flatMap((card) =>
      card.families.flatMap((family) => family.rows),
    );
    // Parents kept for context make the list longer than the count.
    expect(shown.some((row) => parentIds.has(row.feature.id))).toBe(true);
    expect(
      shown.filter((row) => !parentIds.has(row.feature.id)),
    ).toHaveLength(couldAdd.matchCount);
  });

  it("treats a parent's name as a match for the leaves under it", () => {
    const result = filterFeatureCards(cards, {
      query: "Draft additions",
      filter: "all",
    });
    const ids = result.cards.flatMap((card) =>
      card.families.flatMap((family) => family.rows.map((row) => row.feature.id)),
    );
    const draftLeaves = SERVER_FEATURE_CATALOG.filter(
      (feature) => feature.parent === "apps.draft",
    );
    expect(draftLeaves.length).toBeGreaterThan(0);
    expect(ids).toEqual([
      "apps.draft",
      ...draftLeaves.map((feature) => feature.id),
    ]);
    expect(result.matchCount).toBe(draftLeaves.length);
  });

  it("keeps only rows in the chosen state, with their parents", () => {
    const result = filterFeatureCards(cards, { query: "", filter: "could-add" });
    expect(result.active).toBe(true);
    const rows = result.cards.flatMap((card) =>
      card.families.flatMap((family) => family.rows),
    );
    expect(rows.some((row) => row.feature.id === "prompts.capability")).toBe(
      true,
    );
    for (const row of rows) {
      const isParentOfMatch = rows.some(
        (other) => other.feature.parent === row.feature.id,
      );
      expect(row.assessment.state === "could-add" || isParentOfMatch).toBe(
        true,
      );
    }
    // Parents kept for context are not counted as matches.
    const allRows = cards.flatMap((card) =>
      card.families.flatMap((family) => family.rows),
    );
    expect(result.matchCount).toBe(
      allRows.filter(
        (row) =>
          row.assessment.state === "could-add" && !parentIds.has(row.feature.id),
      ).length,
    );
  });

  it("searches official names and ids, and a family name keeps its rows", () => {
    const byMethod = filterFeatureCards(cards, {
      query: "tools/list",
      filter: "all",
    });
    const ids = byMethod.cards.flatMap((card) =>
      card.families.flatMap((family) => family.rows.map((row) => row.feature.id)),
    );
    expect(ids).toContain("tools.list");
    expect(ids).toContain("tools.capability");

    const byFamily = filterFeatureCards(cards, { query: "prompts", filter: "all" });
    const prompts = byFamily.cards
      .flatMap((card) => card.families)
      .find((family) => family.family.id === "prompts");
    expect(prompts?.rows).toHaveLength(7);
  });

  it("matches a family by the id ?feature= takes", () => {
    const tools = cards
      .flatMap((card) => card.families)
      .find((family) => family.family.id === "tools-discovery");
    expect(tools?.family.name).toBe("Tools");
    const result = filterFeatureCards(cards, {
      query: "tools-discovery",
      filter: "all",
    });
    const families = result.cards.flatMap((card) => card.families);
    expect(families.map((family) => family.family.id)).toEqual([
      "tools-discovery",
    ]);
    expect(families[0].rows).toEqual(tools?.rows);
  });

  it("drops cards and families with no matches", () => {
    const result = filterFeatureCards(cards, {
      query: "no-such-feature",
      filter: "all",
    });
    expect(result.cards).toEqual([]);
    expect(result.matchCount).toBe(0);
  });
});

describe("resolveFeatureSelection", () => {
  it("resolves a feature id, a family id, and ignores anything else", () => {
    expect(resolveFeatureSelection("tools.list", SERVER_FEATURE_CATALOG)).toMatchObject({
      kind: "feature",
      feature: { id: "tools.list" },
      family: { id: "tools-discovery" },
    });
    expect(resolveFeatureSelection("mcp-apps", SERVER_FEATURE_CATALOG)).toMatchObject({
      kind: "family",
      family: { id: "mcp-apps" },
    });
    expect(resolveFeatureSelection("nope", SERVER_FEATURE_CATALOG)).toBeNull();
    expect(resolveFeatureSelection(null, SERVER_FEATURE_CATALOG)).toBeNull();
  });

  it("claims nothing for a server that was never connected", () => {
    const cards = buildFeatureCards(
      SERVER_FEATURE_CATALOG,
      neverConnectedEvaluation(),
    );
    const rows = cards.flatMap((card) =>
      card.families.flatMap((family) => family.rows),
    );
    expect(rows.some((row) => row.assessment.state === "not-checked")).toBe(
      true,
    );
    expect(
      rows.some((row) =>
        ["supported", "could-add", "check-failed"].includes(row.assessment.state),
      ),
    ).toBe(false);
  });
});
