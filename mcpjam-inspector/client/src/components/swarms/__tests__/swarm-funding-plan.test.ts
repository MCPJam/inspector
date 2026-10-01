import { describe, expect, it } from "vitest";
import type { SwarmFundingPreview } from "@/lib/swarm-api";
import type { LaunchTarget } from "@/components/swarms/new-swarm-confirm-step";
import {
  alsoFailedNotice,
  creditFundingExplanation,
  fundingChangedNotice,
  fundingHeadline,
  fundingPreviewRuns,
  fundingReviewNotice,
  fundingSplitOf,
  launchRunOverrides,
  withChosenIterations,
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

// Goals created by a first launch attempt are frozen, but Confirm stays editable.
// The counter's value now is measured against what the target already carries,
// and the persisted target itself is never changed, so moving a counter and then
// moving it back sends nothing.
describe("withChosenIterations", () => {
  const created = (overrides: Partial<LaunchTarget> = {}) =>
    target({
      journeyId: "j-new",
      iterationsKey: "ana",
      bornIterations: 3,
      ...overrides,
    });

  it("leaves a goal alone while its counter still reads what the goal was born with", () => {
    const targets = [created()];
    const [same] = withChosenIterations(targets, { ana: 3 });
    expect(same).toBe(targets[0]);
    expect(launchRunOverrides(same!, null)).toEqual({});
  });

  it("makes a moved counter the run's override without changing the persisted target", () => {
    const targets = [created()];
    const [moved] = withChosenIterations(targets, { ana: 2 });
    expect(launchRunOverrides(moved!, null)).toEqual({ sessionsPerTarget: 2 });
    expect(targets[0]).not.toHaveProperty("sessionsPerTarget");

    const [back] = withChosenIterations(targets, { ana: 3 });
    expect(launchRunOverrides(back!, null)).toEqual({});
  });

  it("measures a reused goal against the count it already carries", () => {
    const reused = target({
      iterationsKey: "persona-1",
      sessionsPerTarget: 2,
      environmentIds: ["env-1"],
    });
    expect(withChosenIterations([reused], { "persona-1": 2 })[0]).toBe(reused);
    expect(
      withChosenIterations([reused], { "persona-1": 4 })[0],
    ).toMatchObject({ sessionsPerTarget: 4 });
  });

  it("ignores a target with no key and a key the person never touched", () => {
    const keyless = target({ sessionsPerTarget: 2 });
    const untouched = created();
    const out = withChosenIterations([keyless, untouched], { other: 5 });
    expect(out[0]).toBe(keyless);
    expect(out[1]).toBe(untouched);
  });

  it("keeps the order and the number of targets", () => {
    const targets = [
      created({ journeyId: "a", iterationsKey: "a" }),
      created({ journeyId: "b", iterationsKey: "b" }),
    ];
    const out = withChosenIterations(targets, { a: 1, b: 3 });
    expect(out.map((t) => t.journeyId)).toEqual(["a", "b"]);
    expect(out.map((t) => t.sessionsPerTarget)).toEqual([1, undefined]);
  });
});

describe("alsoFailedNotice", () => {
  it("says what else failed in the same pass, ending in exactly one stop", () => {
    expect(alsoFailedNotice("Goal creation failed")).toBe(
      "Also, part of this launch failed: Goal creation failed.",
    );
    expect(alsoFailedNotice("  Run refused!  ")).toBe(
      "Also, part of this launch failed: Run refused!",
    );
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

  // The old sentence said sponsored conversations "cover MCPJam-hosted models in
  // emulated environments" for EVERY ineligible target. A target held back by the
  // price gate is exactly that, so the sentence contradicted itself. Each reason
  // now says its own cause and nothing broader.
  describe("names why, per reason", () => {
    const explain = (
      targets: Array<{ targetId: string; reason?: string }>,
    ): string =>
      creditFundingExplanation(
        preview({
          remaining: 500,
          runs: [
            {
              sponsored: 0,
              credits: targets.length,
              total: targets.length,
              targets: targets.map((t) => ({ ...t, eligible: false })),
            },
          ],
        }),
        { sponsored: 0, credits: targets.length, total: targets.length },
      ) ?? "";

    it("a price-gated model is not described as an unsupported kind of target", () => {
      const text = explain([{ targetId: "a", reason: "model_not_included" }]);
      expect(text).toBe(
        "One target can't use sponsored conversations (its model isn't included in them), so its conversations use org credits.",
      );
      expect(text).not.toMatch(/emulated environments|MCPJam-hosted models/i);
    });

    it.each([
      ["byok_model", /it uses your own model key/],
      ["harness_target", /it runs a coding-agent harness/],
      ["computer_target", /it uses a computer or shell/],
      ["unresolved", /its setup could not be read/],
    ])("%s", (reason, clause) => {
      expect(explain([{ targetId: "a", reason }])).toMatch(clause);
    });

    it("pluralizes per group", () => {
      expect(
        explain([
          { targetId: "a", reason: "model_not_included" },
          { targetId: "b", reason: "model_not_included" },
        ]),
      ).toBe(
        "2 targets can't use sponsored conversations (their models aren't included in them), so their conversations use org credits.",
      );
    });

    it("says each distinct cause once", () => {
      const text = explain([
        { targetId: "a", reason: "model_not_included" },
        { targetId: "b", reason: "harness_target" },
        { targetId: "c", reason: "model_not_included" },
      ]);
      expect(text).toMatch(
        /2 targets can't use sponsored conversations \(their models/,
      );
      expect(text).toMatch(
        /One target can't use sponsored conversations \(it runs a coding-agent harness\)/,
      );
    });

    it("names a run-wide cause as the cause, whichever target carries it", () => {
      expect(
        explain([{ targetId: "a", reason: "judge_model_not_included" }]),
      ).toMatch(/the judge model isn't included in them/);
      expect(
        explain([{ targetId: "a", reason: "persona_model_not_included" }]),
      ).toMatch(/the persona model isn't included in them/);
    });

    it("counts a target once however many runs carry it", () => {
      const text =
        creditFundingExplanation(
          preview({
            runs: [
              {
                sponsored: 0,
                credits: 1,
                total: 1,
                targets: [
                  { targetId: "a", eligible: false, reason: "byok_model" },
                ],
              },
              {
                sponsored: 0,
                credits: 1,
                total: 1,
                targets: [
                  { targetId: "a", eligible: false, reason: "byok_model" },
                ],
              },
            ],
          }),
          { sponsored: 0, credits: 2, total: 2 },
        ) ?? "";
      expect(text).toMatch(/^One target can't use sponsored conversations/);
    });

    it("says nothing it does not know for a reason it has no wording for", () => {
      const text = explain([{ targetId: "a", reason: "something_new" }]);
      expect(text).toBe(
        "One target can't use sponsored conversations, so its conversations use org credits.",
      );
    });
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

  // `totalConversations` is the refused run's size, not the launch's. "now 0
  // sponsored conversations of 1" beside a 15-conversation split read as a
  // contradiction, so the numbers are said to belong to that run.
  it("a 409 notice says its numbers belong to the refused run", () => {
    const none = fundingChangedNotice({
      launched: 0,
      total: 15,
      actualSponsored: 0,
      totalConversations: 1,
    });
    expect(none).toMatch(/a run now has 0 of its 1 conversation sponsored/);
    expect(none).not.toMatch(/conversations? of \d/);
    const partial = fundingChangedNotice({
      launched: 2,
      total: 15,
      actualSponsored: 1,
      totalConversations: 4,
    });
    expect(partial).toMatch(/it now has 1 of its 4 conversations sponsored/);
    expect(partial).not.toMatch(/conversations? of \d/);
  });

  // Goals launches a run with no preview and no expected count, so sending
  // someone there "to see the updated split" launched the rest on a split nobody
  // looked at, the very thing this notice exists to prevent.
  it("a partial-launch notice points back to the flow that shows the split", () => {
    const partial = fundingChangedNotice({
      launched: 2,
      total: 3,
      actualSponsored: 1,
      totalConversations: 3,
    });
    expect(partial).not.toMatch(/from Goals|to see the updated split/i);
    expect(partial).toMatch(/New swarm/);
  });
});
