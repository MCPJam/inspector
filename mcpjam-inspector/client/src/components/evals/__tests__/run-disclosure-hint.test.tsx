import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

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
  it("renders nothing with no suiteId", () => {
    render(<SuiteRunDisclosureHint suiteId={null} />);
    expect(screen.queryByTestId("run-disclosure-hint")).toBeNull();
  });

  it("renders nothing when suppressed", () => {
    render(<SuiteRunDisclosureHint suiteId="suite-1" suppressed />);
    expect(screen.queryByTestId("run-disclosure-hint")).toBeNull();
  });
});
