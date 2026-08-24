import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

const { useRunDisclosureMock } = vi.hoisted(() => ({
  useRunDisclosureMock: vi.fn(),
}));
vi.mock("@/hooks/use-run-disclosure", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/use-run-disclosure")>();
  return { ...actual, useRunDisclosure: useRunDisclosureMock };
});

/**
 * CONTRACT: the pre-run disclosure hint is read-only. It must never disable,
 * gate, or delay the run control beside it — whatever state the fetch is in
 * (loading, ready, error, contract-unavailable). It also must render
 * DISTINGUISHABLE copy for the two `executionAbsence` kinds: rendering the
 * `'ingested-run'` wording for a `'plan-unresolved'` disclosure tells someone
 * about to launch a run that nothing leaves, when in fact it is about to
 * execute and call models — the exact bug g4a fixed on the backend.
 */

import {
  RunDisclosureHint,
  SuiteRunDisclosureHint,
  describeRunDisclosureDetail,
  formatRunDisclosureSummary,
} from "../run-disclosure-hint";
import { ReviewStep } from "../eval-runner/ReviewStep";
import type { RunDisclosureState } from "@/hooks/use-run-disclosure";
import type { PlatformEvalRunDisclosure } from "@mcpjam/sdk/platform";

afterEach(() => {
  cleanup();
});

function baseDisclosure(
  overrides: Partial<PlatformEvalRunDisclosure> = {},
): PlatformEvalRunDisclosure {
  return {
    contractVersion: 1,
    computedAt: 1,
    digest: "deadbeef",
    execution: {
      engine: "emulated",
      sandbox: { engaged: false, because: "no sandbox" },
      locus: { known: true, hosted: false },
      models: [],
    },
    analysis: [],
    capture: {
      captureLevel: "full",
      reportingMode: "standard",
      tiersImplemented: false,
      redaction: {
        kind: "credential-shaped",
        module: "x",
        isDlp: false,
        limitation: "x",
        appliesTo: [],
      },
      exportDefaults: {
        includeContent: false,
        ruleLocation: "x",
        note: "x",
      },
    },
    retention: {
      planName: "free",
      policyDays: 30,
      source: "x",
      enforced: true,
      enforcementBlockers: [],
      effectiveToday: "swept-after-policy-days",
      evidentiaryClasses: [],
      backupStatement: {
        vendor: "Convex",
        capturedAt: "2026-08-23",
        sourceUrl: "https://x",
        statements: [],
      },
    },
    region: { stated: false, reason: "not derivable" },
    subprocessors: [],
    ...overrides,
  } as PlatformEvalRunDisclosure;
}

function stateOf(
  overrides: Partial<RunDisclosureState> = {},
): RunDisclosureState {
  return {
    status: "ready",
    disclosure: baseDisclosure(),
    error: null,
    open: false,
    setOpen: () => {},
    ...overrides,
  };
}

describe("formatRunDisclosureSummary — executionAbsence kinds render distinguishable copy", () => {
  it("says MCPJam did not execute an ingested run", () => {
    const summary = formatRunDisclosureSummary(
      stateOf({
        disclosure: baseDisclosure({
          execution: undefined,
          executionAbsence: {
            kind: "ingested-run",
            reason: "the SDK uploaded this run",
          },
        }),
      }),
    );
    expect(summary).toMatch(/ingested/i);
    expect(summary).toMatch(/did not execute/i);
  });

  it("says the run WILL execute for an unresolved plan — never the ingest wording", () => {
    const summary = formatRunDisclosureSummary(
      stateOf({
        disclosure: baseDisclosure({
          execution: undefined,
          executionAbsence: {
            kind: "plan-unresolved",
            reason: "no environment resolved",
          },
        }),
      }),
    );
    expect(summary).toMatch(/will execute/i);
    expect(summary).not.toMatch(/ingested/i);
    expect(summary).not.toMatch(/did not execute/i);
  });

  it("produces different copy for the two absence kinds", () => {
    const ingested = formatRunDisclosureSummary(
      stateOf({
        disclosure: baseDisclosure({
          execution: undefined,
          executionAbsence: { kind: "ingested-run", reason: "r" },
        }),
      }),
    );
    const unresolved = formatRunDisclosureSummary(
      stateOf({
        disclosure: baseDisclosure({
          execution: undefined,
          executionAbsence: { kind: "plan-unresolved", reason: "r" },
        }),
      }),
    );
    expect(ingested).not.toBe(unresolved);
  });

  it("never claims 'no models' when models are unresolved but WILL run", () => {
    // An empty `models` list with `modelsUnresolved` set is NOT the same
    // claim as no models running — the plan resolved and will call models,
    // they just are not derivable here. Silently reading the empty list as
    // "no models" would hide that a launch calls models at all.
    const state = stateOf({
      disclosure: baseDisclosure({
        execution: {
          engine: "emulated",
          sandbox: { engaged: false, because: "no sandbox" },
          locus: { known: true, hosted: false },
          models: [],
          modelsUnresolved: {
            reason: "models are chosen by the launching client",
          },
        },
      }),
    });
    const summary = formatRunDisclosureSummary(state);
    expect(summary).toMatch(/aren't resolved|not derivable|unresolved/i);
    const detail = describeRunDisclosureDetail(state);
    expect(
      detail.some((line) => /not derivable/i.test(line)),
    ).toBe(true);
  });

  it("renders where each concrete model routes, and every firing touchpoint's own destinations", () => {
    // The hint's whole point is disclosure — it must not reduce a ready
    // disclosure to a bare count and silently drop the destinations it
    // promises. Two analysis touchpoints firing to DIFFERENT destinations
    // must never share a line, the same class of bug as pooling them under
    // one destination.
    const state = stateOf({
      disclosure: baseDisclosure({
        execution: {
          engine: "emulated",
          sandbox: { engaged: false, because: "no sandbox" },
          locus: { known: true, hosted: false },
          models: [
            {
              modelId: "openai/gpt-5.4-mini",
              provider: "openai",
              tenantEgress: "mcpjam-hosted",
              rail: {
                managed: true,
                possibleDestinations: ["gateway", "openrouter"],
                outcomeIfRunNow: {
                  destination: "gateway",
                  observedAt: 1,
                  volatile: true,
                },
                inputs: {
                  mode: "auto",
                  gatewayEligible: true,
                  hasOpenRouterFallback: null,
                },
                ruleLocation: "x",
                authoritativePerRequestRecord: "llmUsageRecord",
              },
            },
            {
              modelId: "anthropic/claude-opus-5",
              provider: "anthropic",
              tenantEgress: "byok-cloud",
              byok: {
                providerKey: "anthropic",
                runtimeLocation: "cloud",
                baseUrlHost: "byok.example.com",
              },
              rail: {
                managed: false,
                notApplicable: true,
                reason: "BYOK model, not on the managed rail",
                authoritativePerRequestRecord: "llmUsageRecord",
              },
            },
          ],
        },
        analysis: [
          {
            touchpoint: "goalCompletion",
            label: "Goal-completion judge",
            model: "openai/gpt-5.4-mini",
            rail: { fixed: "openrouter", because: "x" },
            destinations: ["OpenRouter (openrouter.ai)"],
            evidenceSent: ["case prompt"],
            fires: "explicit-request-only",
          },
          {
            touchpoint: "runInsights",
            label: "Run insights report",
            model: "openai/gpt-5.4-mini",
            rail: { fixed: "openrouter", because: "x" },
            destinations: ["A different destination entirely"],
            evidenceSent: ["failure signatures"],
            fires: "auto-on-completion",
          },
        ],
        subprocessors: [
          {
            vendor: "Vercel AI Gateway",
            role: "Model gateway",
            dataCategories: [],
            capturedAt: "2026-08-23",
            sourceUrl: "https://x",
            statements: [],
            engaged: true,
            because: "run model resolves to the managed rail",
          },
        ],
      }),
    });
    const detail = describeRunDisclosureDetail(state);
    // Each model's own line names ITS destination — a regression that
    // rendered the wrong model's destination (or dropped it) must fail here,
    // not just a check that the model id appears somewhere.
    expect(
      detail.some(
        (line) =>
          line.includes("openai/gpt-5.4-mini") &&
          (line.includes("gateway") || line.includes("openrouter")),
      ),
    ).toBe(true);
    expect(
      detail.some(
        (line) =>
          line.includes("anthropic/claude-opus-5") &&
          line.includes("byok.example.com"), // lgtm[js/incomplete-url-substring-sanitization] -- rendered UI text in a test assertion, not a URL trust check
      ),
    ).toBe(true);
    // Never pooled onto one line under the other model's destination.
    expect(
      detail.some(
        (line) =>
          line.includes("openai/gpt-5.4-mini") &&
          line.includes("byok.example.com"), // lgtm[js/incomplete-url-substring-sanitization] -- rendered UI text in a test assertion, not a URL trust check
      ),
    ).toBe(false);
    expect(
      detail.some(
        (line) =>
          line.includes("anthropic/claude-opus-5") &&
          (line.includes("gateway") || line.includes("openrouter")),
      ),
    ).toBe(false);
    expect(
      detail.some(
        (line) =>
          line.includes("Goal-completion judge") &&
          line.includes("OpenRouter (openrouter.ai)"),
      ),
    ).toBe(true);
    expect(
      detail.some(
        (line) =>
          line.includes("Run insights report") &&
          line.includes("A different destination entirely"),
      ),
    ).toBe(true);
    // Never pooled onto one line under the first touchpoint's destination.
    expect(
      detail.some(
        (line) =>
          line.includes("Goal-completion judge") &&
          line.includes("Run insights report"),
      ),
    ).toBe(false);
    expect(detail.some((line) => line.includes("Vercel AI Gateway"))).toBe(
      true,
    );
  });
});

describe("RunDisclosureHint — read-only, never gates the run", () => {
  function RowWithRunButton({ state }: { state: RunDisclosureState }) {
    return (
      <div>
        <button type="button">Run all</button>
        <RunDisclosureHint state={state} />
      </div>
    );
  }

  it("renders a plain, never-disabled button whatever the fetch status", () => {
    for (const state of [
      stateOf({ status: "loading", disclosure: null }),
      stateOf({ status: "ready" }),
      stateOf({
        status: "error",
        disclosure: null,
        error: { message: "boom", contractUnavailable: false },
      }),
      stateOf({
        status: "error",
        disclosure: null,
        error: { message: "old backend", contractUnavailable: true },
      }),
    ]) {
      const { unmount } = render(<RowWithRunButton state={state} />);
      const runButton = screen.getByRole("button", { name: "Run all" });
      expect(runButton).not.toBeDisabled();
      const hint = screen.getByTestId("run-disclosure-hint");
      // The hint itself is a plain, always-enabled affordance too — it is
      // information, not a gate a caller must satisfy before running.
      expect(hint).not.toBeDisabled();
      unmount();
    }
  });

  it("never disables the run button after the disclosure resolves to contract_unavailable", () => {
    render(
      <RowWithRunButton
        state={stateOf({
          status: "error",
          disclosure: null,
          error: { message: "old backend", contractUnavailable: true },
        })}
      />,
    );
    expect(screen.getByRole("button", { name: "Run all" })).toBeEnabled();
  });
});

describe("SuiteRunDisclosureHint — gate-then-mount", () => {
  afterEach(() => {
    useRunDisclosureMock.mockReset();
  });

  it("renders nothing with no suiteId", () => {
    render(<SuiteRunDisclosureHint suiteId={null} />);
    expect(screen.queryByTestId("run-disclosure-hint")).toBeNull();
    expect(useRunDisclosureMock).not.toHaveBeenCalled();
  });

  it("renders nothing when suppressed", () => {
    render(<SuiteRunDisclosureHint suiteId="suite-1" suppressed />);
    expect(screen.queryByTestId("run-disclosure-hint")).toBeNull();
    expect(useRunDisclosureMock).not.toHaveBeenCalled();
  });

  it("mounts the fetcher and renders the hint for a real suiteId", () => {
    useRunDisclosureMock.mockReturnValue(
      stateOf({ status: "loading", disclosure: null }),
    );
    render(<SuiteRunDisclosureHint suiteId="suite-1" />);
    expect(screen.getByTestId("run-disclosure-hint")).toBeInTheDocument();
    expect(useRunDisclosureMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, suiteId: "suite-1" }),
    );
  });

  it("passes environmentIds through to the hook", () => {
    useRunDisclosureMock.mockReturnValue(stateOf());
    render(
      <SuiteRunDisclosureHint
        suiteId="suite-1"
        environmentIds={["env-stg", "env-prod"]}
      />,
    );
    expect(useRunDisclosureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        suiteId: "suite-1",
        environmentIds: ["env-stg", "env-prod"],
      }),
    );
  });

  it("reflects a contract_unavailable disclosure's summary in the tooltip trigger's label", () => {
    useRunDisclosureMock.mockReturnValue(
      stateOf({
        status: "error",
        disclosure: null,
        error: { message: "old backend", contractUnavailable: true },
      }),
    );
    render(<SuiteRunDisclosureHint suiteId="suite-1" />);
    expect(
      screen.getByLabelText("What running this suite discloses"),
    ).toBeInTheDocument();
  });

  it("mounts and labels the trigger for a loading fetch", () => {
    useRunDisclosureMock.mockReturnValue(
      stateOf({ status: "loading", disclosure: null }),
    );
    render(<SuiteRunDisclosureHint suiteId="suite-1" />);
    expect(
      screen.getByLabelText("What running this suite discloses"),
    ).toBeInTheDocument();
  });

  it("mounts and labels the trigger for a ready disclosure", () => {
    useRunDisclosureMock.mockReturnValue(stateOf({ status: "ready" }));
    render(<SuiteRunDisclosureHint suiteId="suite-1" />);
    expect(
      screen.getByLabelText("What running this suite discloses"),
    ).toBeInTheDocument();
  });
});

describe("ReviewStep — the runDisclosureState slot is props-only and optional", () => {
  function reviewStepProps(
    overrides: Partial<ComponentProps<typeof ReviewStep>> = {},
  ): ComponentProps<typeof ReviewStep> {
    return {
      suiteName: "My suite",
      suiteDescription: "",
      minimumPassRate: 100,
      selectedServers: [],
      selectedModels: [],
      validTestTemplates: [],
      onSuiteNameChange: () => {},
      onSuiteDescriptionChange: () => {},
      onMinimumPassRateChange: () => {},
      onEditStep: () => {},
      ...overrides,
    };
  }

  it("renders no disclosure hint when the parent has no runDisclosureState yet", () => {
    render(<ReviewStep {...reviewStepProps()} />);
    expect(screen.queryByTestId("run-disclosure-hint")).toBeNull();
  });

  it("renders the disclosure hint beside Models when the parent threads a runDisclosureState", () => {
    render(
      <ReviewStep
        {...reviewStepProps({ runDisclosureState: stateOf() })}
      />,
    );
    expect(screen.getByTestId("run-disclosure-hint")).toBeInTheDocument();
  });
});
