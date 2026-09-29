import { describe, expect, it } from "vitest";
import type { SwarmFundingPreview } from "@/lib/swarm-api";
import type { LaunchTarget } from "@/components/swarms/new-swarm-confirm-step";
import {
  creditFundingExplanation,
  fundingChangedNotice,
  fundingHeadline,
  fundingPreviewRuns,
  fundingReviewNotice,
  fundingSplitOf,
  launchRunOverrides,
} from "../swarm-funding-plan";

const target = (overrides: Partial<LaunchTarget> = {}): LaunchTarget => ({
  journeyId: "j1",
  label: "Ana",
  personaId: "p1",
  personaName: "Ana",
  personaRole: "Ops",
  ...overrides,
});

const preview = (
  overrides: Partial<SwarmFundingPreview> = {},
): SwarmFundingPreview => ({
  supported: true,
  remaining: 500,
  granted: 500,
  runs: [{ sponsored: 5, credits: 10, total: 15, targets: [] }],
  ...overrides,
});

describe("launch overrides and preview runs", () => {
  it("send nothing for a just-created goal, which is born with both", () => {
    expect(launchRunOverrides(target(), ["env-1"])).toEqual({});
  });

  it("send the selection only when a reused goal's stored fan-out differs, and its chosen iterations", () => {
    expect(
      launchRunOverrides(
        target({ environmentIds: ["env-1"], sessionsPerTarget: 3 }),
        ["env-1"],
      ),
    ).toEqual({ sessionsPerTarget: 3 });
    expect(
      launchRunOverrides(
        target({ environmentIds: null, sessionsPerTarget: 2 }),
        ["env-1", "env-2"],
      ),
    ).toEqual({ environmentIds: ["env-1", "env-2"], sessionsPerTarget: 2 });
  });

  it("ask the preview about exactly the runs a launch sends, in order", () => {
    expect(
      fundingPreviewRuns(
        [
          target({
            journeyId: "a",
            environmentIds: null,
            sessionsPerTarget: 2,
          }),
          target({ journeyId: "b" }),
        ],
        ["env-1"],
      ),
    ).toEqual([
      { journeyRefId: "a", environmentIds: ["env-1"], sessionsPerTarget: 2 },
      { journeyRefId: "b" },
    ]);
  });
});

describe("funding split copy", () => {
  it("reads 'N sponsored conversations · M use org credits'", () => {
    expect(fundingHeadline({ sponsored: 5, credits: 10, total: 15 })).toBe(
      "5 sponsored conversations · 10 use org credits",
    );
    expect(fundingHeadline({ sponsored: 1, credits: 1, total: 2 })).toBe(
      "1 sponsored conversation · 1 uses org credits",
    );
    expect(fundingHeadline({ sponsored: 0, credits: 0, total: 0 })).toBe(
      "0 sponsored conversations · 0 use org credits",
    );
  });

  it("makes no claim that anything is free or guaranteed", () => {
    const texts = [
      fundingHeadline({ sponsored: 5, credits: 10, total: 15 }),
      fundingReviewNotice({
        shown: null,
        now: { sponsored: 5, credits: 10, total: 15 },
      }),
      fundingReviewNotice({
        shown: 5,
        now: { sponsored: 0, credits: 15, total: 15 },
      }),
      fundingChangedNotice({
        launched: 1,
        total: 3,
        actualSponsored: 0,
        totalConversations: 4,
      }),
      creditFundingExplanation(
        preview({
          remaining: 0,
          runs: [
            {
              sponsored: 0,
              credits: 3,
              total: 3,
              targets: [{ targetId: "t", eligible: false }],
            },
          ],
        }),
        { sponsored: 0, credits: 3, total: 3 },
      ) ?? "",
    ];
    for (const text of texts) {
      expect(text).not.toMatch(/\bfree\b|guarantee/i);
      expect(text).not.toContain("—");
    }
  });
});

describe("fundingSplitOf", () => {
  it("sums the runs of a supported preview", () => {
    expect(
      fundingSplitOf(
        preview({
          runs: [
            { sponsored: 2, credits: 1, total: 3, targets: [] },
            { sponsored: 1, credits: 0, total: 1, targets: [] },
          ],
        }),
        2,
      ),
    ).toEqual({ sponsored: 3, credits: 1, total: 4 });
  });

  it("is null when sponsorship is unsupported or the preview covers a different number of runs", () => {
    expect(fundingSplitOf(preview({ supported: false }), 1)).toBeNull();
    expect(fundingSplitOf(preview(), 2)).toBeNull();
  });
});

describe("creditFundingExplanation", () => {
  const split = { sponsored: 0, credits: 3, total: 3 };

  it("is silent when nothing uses credits", () => {
    expect(
      creditFundingExplanation(preview(), {
        sponsored: 3,
        credits: 0,
        total: 3,
      }),
    ).toBeNull();
  });

  it("names targets that cannot be sponsored", () => {
    const text = creditFundingExplanation(
      preview({
        runs: [
          {
            sponsored: 0,
            credits: 3,
            total: 3,
            targets: [
              { targetId: "a", eligible: false },
              { targetId: "b", eligible: false },
              { targetId: "c", eligible: true },
            ],
          },
        ],
      }),
      split,
    );
    expect(text).toMatch(/2 targets can't use sponsored conversations/);
    expect(text).toMatch(/org credits/);
  });

  it("says when the allowance is used up or short", () => {
    expect(creditFundingExplanation(preview({ remaining: 0 }), split)).toMatch(
      /allowance is used up/i,
    );
    expect(
      creditFundingExplanation(preview({ remaining: 4 }), {
        sponsored: 4,
        credits: 2,
        total: 6,
      }),
    ).toMatch(/covers 4 more conversations/i);
  });
});

describe("notices", () => {
  it("a first look at a split says nothing was launched, a moved split says what changed", () => {
    expect(
      fundingReviewNotice({
        shown: null,
        now: { sponsored: 2, credits: 0, total: 2 },
      }),
    ).toMatch(/can use sponsored conversations: 2 sponsored conversations/);
    expect(
      fundingReviewNotice({
        shown: 5,
        now: { sponsored: 3, credits: 2, total: 5 },
      }),
    ).toMatch(
      /changed[\s\S]*5 sponsored conversations[\s\S]*3 sponsored[\s\S]*Nothing was launched/,
    );
  });

  it("a 409 notice separates none-launched from a partial launch and never says the rest will retry", () => {
    const none = fundingChangedNotice({
      launched: 0,
      total: 3,
      actualSponsored: 1,
      totalConversations: 3,
    });
    expect(none).toMatch(
      /Nothing was launched and nothing was moved to org credits/,
    );
    const partial = fundingChangedNotice({
      launched: 2,
      total: 3,
      actualSponsored: 1,
      totalConversations: 3,
    });
    expect(partial).toMatch(/Launched 2 of 3 runs/);
    expect(partial).toMatch(/remaining runs were not started/);
    expect(partial).not.toMatch(/retry|retrying/i);
  });
});
