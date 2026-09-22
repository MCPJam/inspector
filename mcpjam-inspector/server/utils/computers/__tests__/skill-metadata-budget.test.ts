import { describe, expect, it } from "vitest";
import {
  applySkillMetadataBudget,
  formatSkillCatalogBody,
  renderBudgetedSkillCatalog,
  SKILL_METADATA_FALLBACK_BUDGET_CHARS,
  skillCatalogOverflowNotice,
  skillMetadataBudgetChars,
} from "../skill-metadata-budget";

describe("skillMetadataBudgetChars", () => {
  it("spends 2% of the model's context", () => {
    // 200k tokens × 2% = 4,000 tokens ≈ 16,000 chars.
    expect(skillMetadataBudgetChars(200_000)).toBe(16_000);
  });

  it("falls back to 8,000 chars when the context size is unknown", () => {
    expect(skillMetadataBudgetChars(undefined)).toBe(
      SKILL_METADATA_FALLBACK_BUDGET_CHARS
    );
  });

  it("treats a nonsensical context length as unknown, never as zero budget", () => {
    // Zero budget would silently advertise no skills at all.
    expect(skillMetadataBudgetChars(0)).toBe(
      SKILL_METADATA_FALLBACK_BUDGET_CHARS
    );
    expect(skillMetadataBudgetChars(Number.NaN)).toBe(
      SKILL_METADATA_FALLBACK_BUDGET_CHARS
    );
    expect(skillMetadataBudgetChars(-1)).toBe(
      SKILL_METADATA_FALLBACK_BUDGET_CHARS
    );
  });
});

describe("applySkillMetadataBudget", () => {
  it("passes a listing that fits through untouched", () => {
    const entries = [
      { ref: "alpha", description: "does alpha" },
      { ref: "beta", description: "does beta" },
    ];
    const result = applySkillMetadataBudget(entries, 8_000);
    expect(result.entries).toEqual(entries);
    expect(result.truncatedRefs).toEqual([]);
    expect(result.omittedRefs).toEqual([]);
  });

  it("truncates a description before omitting the skill", () => {
    const result = applySkillMetadataBudget(
      [{ ref: "alpha", description: "x".repeat(500) }],
      200
    );
    expect(result.omittedRefs).toEqual([]);
    expect(result.truncatedRefs).toEqual(["alpha"]);
    expect(result.entries[0].description.length).toBeLessThan(500);
    // The ellipsis tells the model the text was cut, so it knows `loadSkill`
    // still has the whole thing.
    expect(result.entries[0].description.endsWith("…")).toBe(true);
  });

  it("omits an entry only when what remains cannot describe anything", () => {
    const result = applySkillMetadataBudget(
      [
        { ref: "alpha", description: "x".repeat(200) },
        { ref: "beta", description: "y".repeat(200) },
      ],
      210
    );
    expect(result.truncatedRefs).toEqual(["alpha"]);
    expect(result.omittedRefs).toEqual(["beta"]);
  });

  it("keeps trying later entries after an omission", () => {
    // A long entry exhausting the budget must not hide a short one behind it.
    const result = applySkillMetadataBudget(
      [
        { ref: "alpha", description: "a".repeat(60) },
        { ref: "big", description: "b".repeat(400) },
        { ref: "small", description: "c" },
      ],
      100
    );
    expect(result.entries.map((entry) => entry.ref)).toEqual([
      "alpha",
      "small",
    ]);
    expect(result.omittedRefs).toEqual(["big"]);
  });

  it("charges the origin label, not just ref + description", () => {
    // Same ref and description, one with an origin: the origin must cost.
    const withoutOrigin = applySkillMetadataBudget(
      [
        { ref: "a", description: "x".repeat(50) },
        { ref: "b", description: "y".repeat(50) },
      ],
      140
    );
    const withOrigin = applySkillMetadataBudget(
      [
        { ref: "a", description: "x".repeat(50), origin: "plugin alpha@aaaa1111" },
        { ref: "b", description: "y".repeat(50), origin: "plugin alpha@aaaa1111" },
      ],
      140
    );
    expect(withoutOrigin.truncatedRefs).toEqual([]);
    expect(withoutOrigin.omittedRefs).toEqual([]);
    // The uncharged version fit both entries; charging the origin does not.
    expect(
      withOrigin.truncatedRefs.length + withOrigin.omittedRefs.length
    ).toBeGreaterThan(0);
  });

  it("preserves extra fields on the entries it admits", () => {
    const result = applySkillMetadataBudget(
      [{ ref: "alpha", description: "x".repeat(500), origin: "plugin a" }],
      200
    );
    expect(result.entries[0].origin).toBe("plugin a");
  });
});

describe("renderBudgetedSkillCatalog", () => {
  it("omits origin punctuation when no origin is set", () => {
    const { lines, omittedRefs } = renderBudgetedSkillCatalog(
      [{ ref: "pdf-tools", description: "Process PDFs" }],
      8_000
    );
    expect(lines).toEqual(["- **pdf-tools**: Process PDFs"]);
    expect(omittedRefs).toEqual([]);
  });

  it("keeps the origin-labeled line for effective-path entries", () => {
    const { lines } = renderBudgetedSkillCatalog(
      [
        {
          ref: "alpha/summarize",
          description: "Alpha's summarizer",
          origin: "plugin alpha@aaaa1111",
        },
      ],
      8_000
    );
    expect(lines).toEqual([
      "- **alpha/summarize** (plugin alpha@aaaa1111): Alpha's summarizer",
    ]);
  });

  it("appends the overflow notice outside the catalog lines", () => {
    expect(skillCatalogOverflowNotice(2)).toBe(
      "(2 more skills could not be listed within this model's skill-metadata budget.)"
    );
    const body = formatSkillCatalogBody(
      ["- **a**: d"],
      ["b"]
    );
    expect(body).toContain("- **a**: d");
    expect(body).toContain(skillCatalogOverflowNotice(1));
  });
});
