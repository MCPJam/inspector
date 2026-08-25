/**
 * The proposal disclosure's two halves: which frozen inputs the contract can
 * be asked about at all, and what a full contract projects down to on an
 * approval card.
 *
 * Almost every assertion here is about an ABSENCE. That is the point: for a
 * disclosure, the reassuring value ("emulated, no sandbox", "nothing leaves")
 * is exactly what an unanswered question must never become, so the tests that
 * matter most are the ones proving a field stays OFF rather than defaulting on.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getEvalRunDisclosureOperation,
  runEvalCaseOperation,
  runEvalSuiteOperation,
  type PlatformApiClient,
} from "@mcpjam/sdk/platform";
import type { PlatformEvalRunDisclosure } from "@mcpjam/sdk/platform";
import {
  disclosureForProposal,
  disclosureInputForProposal,
  summarizeDisclosure,
} from "../agent-proposal-disclosure.js";

function baseDisclosure(
  overrides: Partial<PlatformEvalRunDisclosure> = {}
): PlatformEvalRunDisclosure {
  return {
    contractVersion: 1,
    computedAt: 0,
    digest: "deadbeef",
    execution: {
      engine: "emulated",
      sandbox: { engaged: false, because: "no computer environment" },
      locus: { known: true, hosted: true },
      models: [
        {
          modelId: "anthropic/claude-x",
          provider: "anthropic",
          tenantEgress: "mcpjam-hosted",
          rail: {
            managed: true,
            possibleDestinations: ["gateway"],
            outcomeIfRunNow: {
              destination: "gateway",
              observedAt: 0,
              volatile: true,
            },
            inputs: {
              mode: "auto",
              gatewayEligible: true,
              hasOpenRouterFallback: null,
            },
            ruleLocation: "resolveChatProvider",
            authoritativePerRequestRecord: "the run's own record",
          },
        },
      ],
    },
    analysis: [],
    capture: {
      captureLevel: "summary",
      reportingMode: "standard",
      tiersImplemented: false,
      redaction: {
        kind: "regex",
        module: "redact.ts",
        isDlp: false,
        limitation: "patterns only",
        appliesTo: ["prompts"],
      },
      exportDefaults: {
        includeContent: false,
        ruleLocation: "export.ts",
        note: "content excluded by default",
      },
    },
    retention: {
      planName: "pro",
      policyDays: 30,
      source: "entitlements",
      enforced: true,
      enforcementBlockers: [],
      effectiveToday: "swept-after-policy-days",
      evidentiaryClasses: ["runs"],
      backupStatement: {
        vendor: "convex",
        capturedAt: "2026-01-01",
        sourceUrl: "https://example.invalid",
        statements: [],
      },
    },
    region: { stated: false, reason: "not derivable" },
    subprocessors: [],
    ...overrides,
  };
}

/** One analysis touchpoint that CAN fire, on the named model. */
function touchpoint(model: string, fires: "auto-on-completion" | { disabled: true; reason: string }) {
  return {
    touchpoint: "goalCompletion" as const,
    label: "Goal-completion judge",
    model,
    rail: { fixed: "openrouter" as const, because: "fixed" },
    destinations: ["OpenRouter (openrouter.ai)"],
    evidenceSent: ["case prompt"],
    fires,
  };
}

describe("disclosureInputForProposal", () => {
  const suite = runEvalSuiteOperation.name;

  it("maps a frozen suite run onto the disclosure operation's own vocabulary", () => {
    expect(
      disclosureInputForProposal(suite, {
        project: "p1",
        suite: "s1",
        environments: ["env_1", "env_2"],
        cases: ["c1"],
        repetitions: 3,
      })
    ).toEqual({
      project: "p1",
      suite: "s1",
      cases: ["c1"],
      environments: ["env_1", "env_2"],
    });
  });

  it("maps a case run's singular `case` onto `cases`", () => {
    // The two selector vocabularies overlap but are not the same, and this is
    // the one place they differ by more than a name.
    expect(
      disclosureInputForProposal(runEvalCaseOperation.name, {
        project: "p1",
        suite: "s1",
        case: "case_7",
        host: "host_1",
      })
    ).toEqual({
      project: "p1",
      suite: "s1",
      cases: ["case_7"],
      host: "host_1",
    });
  });

  it("collapses a single frozen `hosts` entry onto the singular selector", () => {
    expect(
      disclosureInputForProposal(suite, {
        project: "p1",
        suite: "s1",
        hosts: ["host_1"],
      })
    ).toEqual({ project: "p1", suite: "s1", host: "host_1" });
  });

  it("refuses a MULTI-TARGET host group — no single plan to disclose", () => {
    // The contract answers per launch plan; a fan-out spanning hosts has no
    // single engine or model set, and stitching N round trips would be a
    // different contract than the audit stamp records.
    expect(
      disclosureInputForProposal(suite, {
        project: "p1",
        suite: "s1",
        hosts: ["host_1", "host_2"],
      })
    ).toBeUndefined();
  });

  it("refuses a COMPOSE run — the suite-base derivation would contradict it", () => {
    // Composed models are attached to nothing, so the only query available is
    // the selector-less suite-base one, which the composed models can flatly
    // contradict. That is the exact "emulated, no sandbox moments before a
    // harness booted" failure G4c refused for the host axis.
    expect(
      disclosureInputForProposal(suite, {
        project: "p1",
        suite: "s1",
        compose: { models: ["anthropic/claude-x"] },
      })
    ).toBeUndefined();
  });

  it("refuses an input where `allAttached` survived the freeze", () => {
    // Still present means the freeze degraded, so the target set is whatever
    // is attached at CLICK time — unknown now, nothing honest to disclose.
    expect(
      disclosureInputForProposal(suite, {
        project: "p1",
        suite: "s1",
        allAttached: true,
      })
    ).toBeUndefined();
  });

  it("refuses an incoherent host+environment pair rather than letting the op throw", () => {
    expect(
      disclosureInputForProposal(suite, {
        project: "p1",
        suite: "s1",
        host: "host_1",
        environment: "env_1",
      })
    ).toBeUndefined();
  });

  it("refuses without a project or a suite", () => {
    expect(disclosureInputForProposal(suite, { suite: "s1" })).toBeUndefined();
    expect(disclosureInputForProposal(suite, { project: "p1" })).toBeUndefined();
  });
});

describe("summarizeDisclosure", () => {
  it("carries the digest, engine, sandbox, providers and retention", () => {
    expect(summarizeDisclosure(baseDisclosure())).toEqual({
      digest: "deadbeef",
      engine: "emulated",
      sandbox: { engaged: false },
      runProviders: ["anthropic"],
      byok: false,
      retention: { policyDays: 30, effectiveToday: "swept-after-policy-days" },
    });
  });

  it("names the sandbox vendor when one is engaged", () => {
    const disclosure = baseDisclosure();
    disclosure.execution!.sandbox = {
      engaged: true,
      vendor: "e2b",
      because: "computer environment",
    };
    expect(summarizeDisclosure(disclosure).sandbox).toEqual({
      engaged: true,
      vendor: "e2b",
    });
  });

  it("says NOTHING about execution when the contract resolved no plan", () => {
    // The reassuring reading of an absent execution section is the one thing
    // this must never produce: no engine, no sandbox, no providers, no byok.
    const disclosure = baseDisclosure();
    delete disclosure.execution;
    disclosure.executionAbsence = {
      kind: "plan-unresolved",
      reason: "environments did not resolve",
    };
    const summary = summarizeDisclosure(disclosure);
    expect(summary.engine).toBeUndefined();
    expect(summary.sandbox).toBeUndefined();
    expect(summary.runProviders).toBeUndefined();
    expect(summary.byok).toBeUndefined();
    // The digest and retention still hold — they are facts about content, not
    // about a launch plan.
    expect(summary.digest).toBe("deadbeef");
    expect(summary.retention).toEqual({
      policyDays: 30,
      effectiveToday: "swept-after-policy-days",
    });
  });

  it("omits providers and byok when the models did not resolve", () => {
    // An empty `models` with `modelsUnresolved` means models WILL run and are
    // not derivable here. An empty provider list would read as "nothing
    // egresses" — the same collapse, one field over.
    const disclosure = baseDisclosure();
    disclosure.execution!.models = [];
    disclosure.execution!.modelsUnresolved = { reason: "no environment" };
    const summary = summarizeDisclosure(disclosure);
    expect(summary.runProviders).toBeUndefined();
    expect(summary.byok).toBeUndefined();
    // The engine and sandbox DID resolve, so they are still stated.
    expect(summary.engine).toBe("emulated");
  });

  it("omits runProviders entirely when any model declined classification", () => {
    // ALL-OR-NOTHING: a list with the unclassified model quietly missing names
    // fewer destinations than the run actually reaches.
    const disclosure = baseDisclosure();
    disclosure.execution!.models = [
      ...disclosure.execution!.models,
      {
        modelId: "custom/thing",
        provider: null,
        tenantEgress: "unknown",
        rail: {
          managed: false,
          notApplicable: true,
          reason: "custom provider",
          authoritativePerRequestRecord: "the run's own record",
        },
      },
    ];
    expect(summarizeDisclosure(disclosure).runProviders).toBeUndefined();
  });

  it("reports byok from either the byok block or the tenant egress", () => {
    const viaBlock = baseDisclosure();
    viaBlock.execution!.models[0]!.byok = {
      providerKey: "k1",
      runtimeLocation: "cloud",
    };
    expect(summarizeDisclosure(viaBlock).byok).toBe(true);

    const viaEgress = baseDisclosure();
    viaEgress.execution!.models[0]!.tenantEgress = "byok-local";
    expect(summarizeDisclosure(viaEgress).byok).toBe(true);
  });

  it("lists only judge providers the run does NOT already reach", () => {
    const disclosure = baseDisclosure({
      analysis: [
        touchpoint("openai/gpt-5.4-mini", "auto-on-completion"),
        // Same provider the run itself uses: not a surprise, so not stated.
        touchpoint("anthropic/claude-x", "auto-on-completion"),
      ],
    });
    expect(summarizeDisclosure(disclosure).judgeProviders).toEqual(["openai"]);
  });

  it("ignores touchpoints that cannot fire", () => {
    // Warning about egress that cannot happen is the mirror image of hiding
    // egress that can — dishonest in the other direction.
    const disclosure = baseDisclosure({
      analysis: [
        touchpoint("openai/gpt-5.4-mini", {
          disabled: true,
          reason: "no analyzer key",
        }),
      ],
    });
    expect(summarizeDisclosure(disclosure).judgeProviders).toBeUndefined();
  });

  it("lists every firing judge when the run's own providers are unknown", () => {
    // Nothing to subtract, so nothing is subtracted — erring toward
    // disclosing more, the only direction a disclosure may err.
    const disclosure = baseDisclosure({
      analysis: [touchpoint("openai/gpt-5.4-mini", "auto-on-completion")],
    });
    disclosure.execution!.models[0]!.provider = null;
    const summary = summarizeDisclosure(disclosure);
    expect(summary.runProviders).toBeUndefined();
    expect(summary.judgeProviders).toEqual(["openai"]);
  });

  it("omits judgeProviders when a judge model carries no vendor prefix", () => {
    const disclosure = baseDisclosure({
      analysis: [
        touchpoint("openai/gpt-5.4-mini", "auto-on-completion"),
        touchpoint("some-bare-model-id", "auto-on-completion"),
      ],
    });
    expect(summarizeDisclosure(disclosure).judgeProviders).toBeUndefined();
  });

  it("takes `effectiveToday` from the contract, never from policyDays", () => {
    // An unenforced policy keeps data indefinitely whatever its number says.
    const disclosure = baseDisclosure();
    disclosure.retention.effectiveToday = "kept-indefinitely";
    expect(summarizeDisclosure(disclosure).retention).toEqual({
      policyDays: 30,
      effectiveToday: "kept-indefinitely",
    });
  });
});

describe("disclosureForProposal", () => {
  // The operation is the only thing this wrapper talks to, so it is the only
  // thing mocked: everything else under test here is the wrapper's own
  // contract — bound the fetch, swallow every failure, never call out for a
  // plan the mapping already refused.
  const client = {} as PlatformApiClient;
  const FROZEN = { project: "p1", suite: "ts_1" };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockLookup(
    implementation: (
      input: unknown,
      context: { client: PlatformApiClient; signal?: AbortSignal }
    ) => Promise<unknown>
  ) {
    return vi
      .spyOn(getEvalRunDisclosureOperation, "execute")
      .mockImplementation(implementation as never);
  }

  it("summarizes a successful lookup, asked with the MAPPED input", async () => {
    const spy = mockLookup(async () => baseDisclosure());
    const summary = await disclosureForProposal({
      operationName: runEvalCaseOperation.name,
      input: { ...FROZEN, case: "case_7" },
      client,
    });
    expect(summary).toMatchObject({ digest: "deadbeef", engine: "emulated" });
    // The wrapper hands over the disclosure vocabulary, not the run's.
    expect(spy).toHaveBeenCalledWith(
      { project: "p1", suite: "ts_1", cases: ["case_7"] },
      expect.objectContaining({ client })
    );
  });

  it(
    "bounds the fetch with a signal that aborts ON ITS OWN",
    async () => {
      // The single most important safety property of this path: a stalled
      // backend must not be able to hold a mint open indefinitely. Asserting
      // "an AbortSignal was passed" would pass for a signal nobody ever
      // aborts, so this waits for the abort to actually fire and checks it
      // came from a TIMEOUT rather than a caller — there is no caller signal
      // here, deliberately, so nothing else could have aborted it.
      let captured: AbortSignal | undefined;
      mockLookup(async (_input, context) => {
        captured = context.signal;
        return baseDisclosure();
      });
      await disclosureForProposal({
        operationName: runEvalSuiteOperation.name,
        input: FROZEN,
        client,
      });
      expect(captured).toBeInstanceOf(AbortSignal);
      expect(captured!.aborted).toBe(false);
      await new Promise<void>((resolve) =>
        captured!.addEventListener("abort", () => resolve(), { once: true })
      );
      expect((captured!.reason as Error | undefined)?.name).toBe("TimeoutError");
    },
    10_000
  );

  it("returns undefined — never throws — when the lookup rejects", async () => {
    // A transient error, a 5xx, anything. The mint proceeds without a line.
    mockLookup(async () => {
      throw new Error("upstream exploded");
    });
    await expect(
      disclosureForProposal({
        operationName: runEvalSuiteOperation.name,
        input: FROZEN,
        client,
      })
    ).resolves.toBeUndefined();
  });

  it("returns undefined on a backend that predates the contract", async () => {
    // `422 FEATURE_NOT_SUPPORTED` is the DESIGNED degrade, not a fault — it is
    // what every mint gets until the backend half is promoted.
    mockLookup(async () => {
      throw new Error("FEATURE_NOT_SUPPORTED: contract_unavailable");
    });
    await expect(
      disclosureForProposal({
        operationName: runEvalSuiteOperation.name,
        input: FROZEN,
        client,
      })
    ).resolves.toBeUndefined();
  });

  it("returns undefined when the fetch is aborted by its own timeout", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "TimeoutError";
    mockLookup(async () => {
      throw abortError;
    });
    await expect(
      disclosureForProposal({
        operationName: runEvalSuiteOperation.name,
        input: FROZEN,
        client,
      })
    ).resolves.toBeUndefined();
  });

  it("returns undefined on the operation's own one-plan refusal", async () => {
    // A suite with several attached targets and no selector, or a group the
    // contract cannot answer for: the operation throws, and that reaches the
    // approver as an absent line rather than a failed mint.
    mockLookup(async () => {
      throw new Error("Disclosure covers ONE launch plan");
    });
    await expect(
      disclosureForProposal({
        operationName: runEvalSuiteOperation.name,
        input: FROZEN,
        client,
      })
    ).resolves.toBeUndefined();
  });

  it("never calls out for a plan the mapping already refused", async () => {
    // Not just "returns undefined": a refused mapping must cost ZERO round
    // trips, because the answer is already known and a mint is waiting on it.
    const spy = mockLookup(async () => baseDisclosure());
    for (const input of [
      { ...FROZEN, hosts: ["h1", "h2"] },
      { ...FROZEN, compose: { models: ["anthropic/claude-x"] } },
      { ...FROZEN, allAttached: true },
      { ...FROZEN, host: "h1", environment: "env_1" },
    ]) {
      await expect(
        disclosureForProposal({
          operationName: runEvalSuiteOperation.name,
          input,
          client,
        })
      ).resolves.toBeUndefined();
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses empty and missing selectors without calling out", async () => {
    const spy = mockLookup(async () => baseDisclosure());
    for (const input of [
      {},
      { project: "p1" },
      { suite: "ts_1" },
      // Whitespace-only is empty: a selector that trims to nothing cannot
      // identify a plan, and sending it would just move the failure one hop.
      { project: "   ", suite: "ts_1" },
      { project: "p1", suite: "   " },
      { project: null, suite: "ts_1" },
      { project: "p1", suite: 42 },
    ] as Array<Record<string, unknown>>) {
      await expect(
        disclosureForProposal({
          operationName: runEvalSuiteOperation.name,
          input,
          client,
        })
      ).resolves.toBeUndefined();
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
