/**
 * The credit-refusal `recovery`: parsing, the one sentence every surface shows,
 * and the SDK surfaces that show it (the decision summary's next action, the
 * error describer, the run read). The corpus is shared with the Inspector and
 * CLI tests so all of them are held to the same sentence for the same refusal.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  assembleEvalRunDecisionSummary,
  deriveStageResults,
  findCreditRecovery,
  formatCreditRecovery,
  NEXT_ACTION_BY_FAILURE_CATEGORY,
  NEXT_ACTION_BY_INFRA_CLASS,
  parseCreditRecovery,
} from "../src/contract/index.js";
import { describeError } from "../src/error-describer/index.js";
import { readEvalRunCreditRecovery } from "../src/eval-credit-recovery.js";

type CreditRefusalFixture = {
  __name: string;
  stopsRun: boolean;
  body: Record<string, unknown> & { error: string; code: string };
  expectedRecovery: string | null;
  expectedUrl: string | null;
};

const corpus = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("./fixtures/credit-refusal-fixtures.json", import.meta.url)
    ),
    "utf8"
  )
) as { cases: CreditRefusalFixture[] };

const recoveryCases = corpus.cases.filter(
  (fixture) => fixture.expectedRecovery !== null
);

describe("formatCreditRecovery", () => {
  it.each(recoveryCases.map((fixture) => [fixture.__name, fixture] as const))(
    "%s: leads with the step and its link",
    (_name, fixture) => {
      const recovery = parseCreditRecovery(fixture.body.recovery);
      expect(recovery).toBeDefined();
      const sentence = formatCreditRecovery(recovery!);
      expect(sentence).toBe(fixture.expectedRecovery);
      expect(sentence).toContain(fixture.expectedUrl!);
    }
  );

  it("puts the wait last, and only with a real reset time", () => {
    const base = {
      version: 1,
      reason: "allowance_exhausted",
      action: "upgrade_plan",
      actor: "caller",
      plan: "pro",
    } as const;
    expect(formatCreditRecovery(base)).toBe(
      "Upgrade to Pro to keep going. BYOK avoids MCPJam model charges."
    );
    expect(formatCreditRecovery(base, { resetAt: 1795046400000 })).toBe(
      "Upgrade to Pro to keep going. BYOK avoids MCPJam model charges. The allowance resets at 2026-11-19 00:00 UTC."
    );
    expect(
      formatCreditRecovery({ ...base, action: "wait", resetAt: 1795046400000 })
    ).toBe("Retry after the MCPJam allowance resets at 2026-11-19 00:00 UTC.");
    expect(formatCreditRecovery({ ...base, action: "wait" })).toBe(
      "Retry once the MCPJam allowance resets."
    );
  });

  it("leaves BYOK out where it does not avoid the charge", () => {
    expect(
      formatCreditRecovery({
        version: 1,
        reason: "platform_fee_required",
        action: "buy_credits",
        actor: "owner_or_admin",
        url: "https://app.mcpjam.com/organizations/org_1/billing?topup=open",
      })
    ).toBe(
      "Ask an organization owner or admin to buy credits: https://app.mcpjam.com/organizations/org_1/billing?topup=open."
    );
  });

  it("names a plan it does not know generically, never a prototype member", () => {
    for (const plan of ["galaxy", "constructor", "__proto__"]) {
      expect(
        formatCreditRecovery({
          version: 1,
          reason: "allowance_exhausted",
          action: "upgrade_plan",
          actor: "caller",
          plan,
        })
      ).toMatch(/^Upgrade to a paid plan to keep going\./);
    }
  });
});

describe("parseCreditRecovery", () => {
  const valid = {
    version: 1,
    reason: "allowance_exhausted",
    action: "buy_credits",
    actor: "caller",
    url: "https://app.mcpjam.com/organizations/org_1/billing?topup=open",
  };

  it("returns undefined for anything that is not a v1 recovery, without throwing", () => {
    for (const value of [
      undefined,
      null,
      "buy credits",
      [],
      { ...valid, version: 2 },
      { ...valid, action: "pay_us" },
      { ...valid, actor: "anyone" },
      { ...valid, reason: "" },
      { ...valid, resetAt: -1 },
    ]) {
      expect(parseCreditRecovery(value)).toBeUndefined();
    }
  });

  it("keeps a field a newer backend adds from discarding the step", () => {
    expect(parseCreditRecovery({ ...valid, newField: true })).toEqual(valid);
  });

  it.each([
    "http://app.mcpjam.com/organizations/org_1/billing",
    "https://app.mcpjam.com.evil.example/billing",
    "https://evil.example/?u=app.mcpjam.com",
    "https://user:pass@app.mcpjam.com/billing",
    "javascript:alert(1)",
    "not a url",
  ])("drops %s and keeps the step", (url) => {
    const parsed = parseCreditRecovery({ ...valid, url });
    expect(parsed).toBeDefined();
    expect(parsed?.url).toBeUndefined();
    expect(formatCreditRecovery(parsed!)).toBe(
      "Buy credits to keep going. BYOK avoids MCPJam model charges."
    );
  });

  it("finds the recovery inside a refusal however it is wrapped", () => {
    const [fixture] = recoveryCases;
    const expected = parseCreditRecovery(fixture!.body.recovery);
    const wrapped = `https://x.convex.site/stream failed (429): ${JSON.stringify(fixture!.body)}`;
    expect(findCreditRecovery(fixture!.body)).toEqual(expected);
    expect(findCreditRecovery(wrapped)).toEqual(expected);
    expect(
      findCreditRecovery({ message: "refused", details: wrapped })
    ).toEqual(expected);
    expect(
      findCreditRecovery(
        Object.assign(new Error(fixture!.body.error), {
          details: fixture!.body,
        })
      )
    ).toEqual(expected);
    expect(findCreditRecovery({ message: "{not json" })).toBeUndefined();
  });
});

describe("the decision summary's next action on an account_limit trial", () => {
  const derivation = deriveStageResults({
    authored: {
      mode: "model_driven",
      expectsToolCall: true,
      assertionCount: 1,
    },
    evidence: {
      setupSignals: {
        connection: { outcome: "ok" },
        discovery: { outcome: "ok" },
      },
      prompts: [{ promptIndex: 0, missing: [{ toolName: "search" }] }],
      stepError: { source: "model" },
    },
    iteration: { status: "failed" },
  });

  const nextActionFor = (infraError: { class: string; recovery?: unknown }) =>
    assembleEvalRunDecisionSummary({
      projectId: "project-1",
      run: { id: "run-1", status: "failed", result: "failed" },
      iterations: [
        {
          id: "iteration-1",
          iterationNumber: 1,
          status: "failed",
          result: "failed",
          error: "refused",
          stageResults: derivation.stageResults,
          failureCategory: derivation.failureCategory,
          stageAnalyzerVersion: derivation.stageAnalyzerVersion,
          infraError,
        },
      ],
      page: { complete: true },
    }).diagnostics.items[0]!.nextAction;

  it.each(corpus.cases.map((fixture) => [fixture.__name, fixture] as const))(
    "%s",
    (_name, fixture) => {
      const nextAction = nextActionFor({
        class: "account_limit",
        ...(fixture.body.recovery ? { recovery: fixture.body.recovery } : {}),
      });
      expect(nextAction).toBe(
        fixture.expectedRecovery ?? NEXT_ACTION_BY_INFRA_CLASS.account_limit
      );
      expect(nextAction).not.toContain("server connection");
      expect(nextAction).not.toBe(NEXT_ACTION_BY_FAILURE_CATEGORY.setup);
    }
  );

  it("ignores a recovery on a class that is not a credit refusal", () => {
    expect(
      nextActionFor({
        class: "capacity",
        recovery: recoveryCases[0]!.body.recovery,
      })
    ).toBe(NEXT_ACTION_BY_INFRA_CLASS.capacity);
  });
});

describe("the error describer", () => {
  it.each(
    corpus.cases
      .filter((fixture) => fixture.body.code === "user_rate_limit")
      .map((fixture) => [fixture.__name, fixture] as const)
  )("%s", (_name, fixture) => {
    const described = describeError(
      Object.assign(new Error(fixture.body.error), { details: fixture.body })
    );
    expect(described.slug).toMatch(/^provider\/mcpjam_limit/);
    if (fixture.expectedRecovery === null) {
      expect(described.nextSteps[0]).toMatch(/^On Free, upgrade/);
      return;
    }
    expect(described.nextSteps[0]).toBe(fixture.expectedRecovery);
    expect(described.nextSteps.join(" ")).not.toMatch(/On Free, upgrade/);
  });
});

describe("readEvalRunCreditRecovery", () => {
  const [fixture] = recoveryCases;
  const iterations = [
    { id: "i-1", infraError: null },
    {
      id: "i-2",
      infraError: {
        class: "account_limit",
        layer: "platform",
        retryable: false,
        recovery: fixture!.body.recovery,
      },
    },
  ];

  it("reads the first page of a failed run's trials for the recovery", async () => {
    const listEvalRunIterations = vi
      .fn()
      .mockResolvedValue({ items: iterations });
    const recovery = await readEvalRunCreditRecovery(
      { listEvalRunIterations },
      undefined,
      "project-1",
      { id: "run-1", status: "failed" }
    );
    expect(formatCreditRecovery(recovery!)).toBe(fixture!.expectedRecovery);
    expect(listEvalRunIterations).toHaveBeenCalledWith(
      { projectId: "project-1", runId: "run-1", limit: 200 },
      { signal: undefined }
    );
  });

  it("makes no read for a run that did not fail, and fails soft", async () => {
    const listEvalRunIterations = vi.fn().mockRejectedValue(new Error("down"));
    await expect(
      readEvalRunCreditRecovery({ listEvalRunIterations }, undefined, "p", {
        id: "r",
        status: "completed",
      })
    ).resolves.toBeUndefined();
    expect(listEvalRunIterations).not.toHaveBeenCalled();
    await expect(
      readEvalRunCreditRecovery({ listEvalRunIterations }, undefined, "p", {
        id: "r",
        status: "failed",
      })
    ).resolves.toBeUndefined();
  });
});
