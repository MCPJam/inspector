import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { useRunDisclosureMock } = vi.hoisted(() => ({
  useRunDisclosureMock: vi.fn(),
}));
vi.mock("@/hooks/use-run-disclosure", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/use-run-disclosure")>();
  return { ...actual, useRunDisclosure: useRunDisclosureMock };
});

// The rollout flag defaults to enabled here — the sibling
// `useCreditEstimateEnabled` tests use the same default-true pattern — so
// every other test in this file exercises the gated-open path. The gate
// itself gets its own describe block below, flipping this to false.
let runDisclosureFlagEnabled: boolean | undefined = true;
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => runDisclosureFlagEnabled,
}));

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
    // `execution.locus` — the one field this route composes onto the backend
    // contract — must not be the field the tooltip never mentions.
    expect(
      detail.some((line) => /Execution: emulated .* your own machine/.test(line)),
    ).toBe(true);
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
    // `possibleDestinations` is the SET a managed rail could pick from;
    // `outcomeIfRunNow.destination` is the concrete one selected at
    // disclosure time. Both must be visible — the set alone tells a browser
    // user strictly less than the CLI's own "(currently: …)" phrasing.
    expect(
      detail.some(
        (line) =>
          line.includes("openai/gpt-5.4-mini") &&
          line.includes("gateway or openrouter") &&
          line.includes("(currently: gateway)"),
      ),
    ).toBe(true);
    // Matched with a regex rather than `.includes("byok.example.com")` —
    // CodeQL's incomplete-URL-substring-sanitization query pattern-matches
    // that idiom regardless of context, and flags it as if this were a host
    // trust check instead of a plain assertion on rendered UI test text.
    const byokDestination = /byok\.example\.com/;
    expect(
      detail.some(
        (line) =>
          line.includes("anthropic/claude-opus-5") &&
          byokDestination.test(line),
      ),
    ).toBe(true);
    // Never pooled onto one line under the other model's destination.
    expect(
      detail.some(
        (line) =>
          line.includes("openai/gpt-5.4-mini") && byokDestination.test(line),
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
    // "fires automatically" vs "fires only if asked" are different consent
    // stories — the fixture's Goal-completion judge is explicit-request-only,
    // Run insights report is auto-on-completion.
    expect(
      detail.some(
        (line) =>
          line.includes("Goal-completion judge") &&
          line.includes("fires only if requested"),
      ),
    ).toBe(true);
    expect(
      detail.some(
        (line) =>
          line.includes("Run insights report") &&
          line.includes("auto-fires on completion"),
      ),
    ).toBe(true);
  });

  it("renders capture and redaction facts — the tooltip's only pre-launch view of what gets stored", () => {
    // Consequential settings (full capture, a non-DLP redaction module,
    // content-inclusive export defaults) must not be silently absent just
    // because this hint prioritizes destinations and analysis.
    const state = stateOf({
      disclosure: baseDisclosure({
        capture: {
          captureLevel: "full",
          reportingMode: "standard",
          tiersImplemented: false,
          redaction: {
            kind: "credential-shaped",
            module: "x",
            isDlp: false,
            limitation: "not DLP",
            appliesTo: [],
          },
          exportDefaults: {
            includeContent: false,
            ruleLocation: "x",
            note: "redacted by default",
          },
        },
      }),
    });
    const detail = describeRunDisclosureDetail(state);
    expect(
      detail.some((line) => /Capture: full · reporting standard/.test(line)),
    ).toBe(true);
    expect(
      detail.some((line) =>
        /Redaction: credential-shaped — not a DLP system \(not DLP\)/.test(
          line,
        ),
      ),
    ).toBe(true);
    expect(
      detail.some((line) =>
        /Export defaults: excludes content \(redacted by default\)/.test(
          line,
        ),
      ),
    ).toBe(true);
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

  it("renders nothing — and never fetches — when the rollout flag is off", () => {
    // The backend contract is not promoted to production yet: without this
    // gate every prod hover would fire a request that 422s. Flag off must
    // mean the fetch never fires, not just that the icon is hidden.
    runDisclosureFlagEnabled = false;
    try {
      render(<SuiteRunDisclosureHint suiteId="suite-1" />);
      expect(screen.queryByTestId("run-disclosure-hint")).toBeNull();
      expect(useRunDisclosureMock).not.toHaveBeenCalled();
    } finally {
      runDisclosureFlagEnabled = true;
    }
  });

  it("treats an undefined flag (still loading, or the flag does not exist) as off", () => {
    runDisclosureFlagEnabled = undefined;
    try {
      render(<SuiteRunDisclosureHint suiteId="suite-1" />);
      expect(screen.queryByTestId("run-disclosure-hint")).toBeNull();
      expect(useRunDisclosureMock).not.toHaveBeenCalled();
    } finally {
      runDisclosureFlagEnabled = true;
    }
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

  it("FETCHES for a single attached host, passing namedHostId (G4c un-refusal)", () => {
    // `testSuites:getRunDisclosure` takes `namedHostId` since G4c, so the one
    // host Run all would target is disclosed for real — engine and sandbox
    // read off that host's own config. Before G4c this skipped the fetch and
    // rendered a static refusal, because the only available query was the
    // selector-less suite-base derivation a host config can contradict.
    useRunDisclosureMock.mockReturnValue(stateOf({ status: "ready" }));
    render(
      <SuiteRunDisclosureHint
        suiteId="suite-1"
        environmentIds={[]}
        hostIds={["host-1"]}
      />,
    );
    expect(useRunDisclosureMock).toHaveBeenCalledWith(
      expect.objectContaining({ suiteId: "suite-1", namedHostId: "host-1" }),
    );
    expect(
      screen.getByLabelText("What running this suite discloses"),
    ).toBeInTheDocument();
  });

  it("does NOT send a host when environments are attached — the environment axis wins", () => {
    // Same precedence `computeRunTargets` uses. Sending both would be the
    // one-axis violation the route rejects with a 400.
    useRunDisclosureMock.mockReturnValue(stateOf({ status: "ready" }));
    render(
      <SuiteRunDisclosureHint
        suiteId="suite-1"
        environmentIds={["env-1"]}
        hostIds={["host-1"]}
      />,
    );
    const call = useRunDisclosureMock.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(call.environmentIds).toEqual(["env-1"]);
    expect(call.namedHostId).toBeUndefined();
  });

  it("never fetches for SEVERAL hosts — one plan, one disclosure", () => {
    // The remaining honest refusal: the contract answers for one launch plan,
    // so a fan-out across hosts has no single engine or model set to
    // describe. Mirrors the SDK's `isMultiTargetHostLaunch` skip.
    render(
      <SuiteRunDisclosureHint
        suiteId="suite-1"
        environmentIds={[]}
        hostIds={["host-1", "host-2"]}
      />,
    );
    expect(useRunDisclosureMock).not.toHaveBeenCalled();
    expect(
      screen.getByLabelText("What running this suite discloses"),
    ).toBeInTheDocument();
  });

  it("multi-target summary reads distinctly from a generic fetch failure, and CARRIES the recovery instruction", () => {
    // The instruction has to live in the SUMMARY: `describeRunDisclosureDetail`
    // bails to `[]` for every non-ready state and never receives `error`, so
    // guidance parked on `error.message` would never reach a user.
    const summary = formatRunDisclosureSummary({
      status: "error",
      disclosure: null,
      error: {
        message: "n/a",
        contractUnavailable: false,
        multiTargetUnavailable: true,
      },
    });
    expect(summary).toMatch(/covers one target/);
    expect(summary).toMatch(/Run one host at a time/);
    expect(
      formatRunDisclosureSummary({
        status: "error",
        disclosure: null,
        error: { message: "boom", contractUnavailable: false },
      }),
    ).not.toBe(summary);
  });

  it("RENDERS the multi-target recovery instruction in the tooltip, not just returns it", () => {
    // Guards the actual failure mode: a string that exists but never paints.
    render(
      <SuiteRunDisclosureHint
        suiteId="suite-1"
        environmentIds={[]}
        hostIds={["host-1", "host-2"]}
      />,
    );
    // Radix opens the tooltip on FOCUS (the trigger's own onClick only stops
    // propagation) — a click alone leaves the content unmounted in jsdom.
    fireEvent.focus(screen.getByLabelText("What running this suite discloses"));
    expect(
      screen.getAllByText(/Run one host at a time/).length,
    ).toBeGreaterThan(0);
  });
});
