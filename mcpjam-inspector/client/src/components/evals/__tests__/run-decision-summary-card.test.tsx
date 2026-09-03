/**
 * The run decision summary, rendered against the SDK's OWN golden corpus.
 *
 * `sdk/tests/fixtures/eval-run-decision-summary-fixtures.json` is read
 * directly — not copied — so this surface is inside the claim the corpus
 * exists to make: that the API, the Platform MCP server, the CLI, the
 * structured reports and now the browser are ONE reading of a run. A UI
 * asserting against its own copy of the rows quietly stops being part of that
 * claim the first time the corpus is regenerated.
 *
 * What the assertions are guarding, in order of how badly each one misleads:
 *
 *   - **`notEstablished` is not `inconclusive`.** One is the absence of a
 *     verdict; the other is a verdict the validity phase reached and withheld.
 *   - **A stage-less outcome stays stage-less.** A setup abort and an
 *     evaluator error never reached a stage; naming one would be a claim about
 *     where the run broke that nothing established.
 *   - **A quarantined chain says so.** `unverified` withholds BOTH the first
 *     failed stage and the failure category, because those are assertions
 *     about rows that did not validate.
 *   - **The unit travels with the number.** Policy-v2 counts are case
 *     variants; a legacy run's are TRIALS, and a reader who cannot tell will
 *     compare the two.
 *   - **Repetitions are trials inside a case, not cases.** A case can pass
 *     with a failing trial under it, and the failing trial still appears as
 *     evidence beneath a PASSED run.
 *   - **"User value", never `userValue`. "First failed stage", never "root
 *     cause".**
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunDecisionSummaryCard } from "../run-decision-summary-card";
import {
  readAllDecisionSummaryFixtures,
  readDecisionSummaryFixture,
} from "@/test/eval-decision-summary-fixtures";
import { EvalRunDecisionSummaryError } from "@/lib/apis/eval-run-decision-summary-api";
import { isDiagnosticTraceable } from "../run-decision-summary-presentation";
import {
  USER_VALUE_STAGE_LABELS,
  USER_VALUE_STAGE_OUTCOMES,
  type EvalRunDecisionSummary,
} from "@mcpjam/sdk/contract";

afterEach(cleanup);

function renderSummary(
  summary: EvalRunDecisionSummary,
  overrides: Partial<
    Parameters<typeof RunDecisionSummaryCard>[0]
  > = {},
) {
  return render(
    <RunDecisionSummaryCard
      status="ready"
      summary={summary}
      error={null}
      diagnostics={summary.diagnostics.items}
      scannedIterations={summary.diagnostics.scannedIterations}
      serverComplete={summary.diagnostics.complete}
      walkExhausted={summary.diagnostics.nextCursor === undefined}
      canLoadMore={summary.diagnostics.nextCursor !== undefined}
      isLoadingMore={false}
      pageError={null}
      onLoadMore={() => {}}
      onRetryFailedPage={() => {}}
      {...overrides}
    />,
  );
}

const VERDICT_TEXT: Record<string, string> = {
  passed: "Passed",
  failed: "Failed",
  inconclusive: "Inconclusive",
  notEstablished: "No verdict",
};

describe("RunDecisionSummaryCard over the golden corpus", () => {
  it.each(readAllDecisionSummaryFixtures())(
    "%s renders the run's own verdict and never a raw wire spelling",
    (_name, summary) => {
      renderSummary(summary);

      expect(screen.getByTestId("run-decision-verdict")).toHaveTextContent(
        VERDICT_TEXT[summary.verdict],
      );

      const card = screen.getByTestId("run-decision-summary");
      // The two spellings this initiative pinned human words for. A regression
      // in either reads as a leaked enum in front of an operator.
      expect(card.textContent).not.toMatch(/userValue/);
      expect(card.textContent).not.toMatch(/root cause/i);
      // Nor any other lowerCamel wire member from the closed vocabularies.
      expect(card.textContent).not.toMatch(/argumentMismatch|notReached|notMeasured|serverData/);
    },
  );

  it.each(readAllDecisionSummaryFixtures())(
    "%s states the population its counts are in",
    (_name, summary) => {
      renderSummary(summary);

      if (!summary.counts) {
        expect(screen.queryByTestId("run-decision-counts")).toBeNull();
        return;
      }
      const counts = screen.getByTestId("run-decision-counts");
      if (summary.counts.measurementUnit === "caseVariant") {
        expect(counts).toHaveTextContent(
          `${summary.counts.passed} passed · ${summary.counts.failed} failed · ${summary.counts.inconclusive} inconclusive of ${summary.counts.total} case variant`,
        );
      } else {
        expect(counts.textContent).toMatch(/trial/);
      }
    },
  );
});

describe("verdicts that are not failures", () => {
  it("says a run reached no verdict, and does not call it inconclusive", () => {
    const summary = readDecisionSummaryFixture(
      "non-terminal-run-is-notEstablished",
    );
    renderSummary(summary);

    expect(screen.getByTestId("run-decision-verdict")).toHaveTextContent(
      "No verdict",
    );
    expect(screen.getByTestId("run-decision-undecided")).toHaveTextContent(
      "the run has not finished yet",
    );
    expect(
      screen.getByTestId("run-decision-summary").textContent,
    ).not.toMatch(/Inconclusive/);
    // No verdict means no counts: numbers a run happens to have recorded
    // describe a decision nobody took.
    expect(screen.queryByTestId("run-decision-counts")).toBeNull();
  });

  it("explains a run that stopped without a verdict as a status, not a defect", () => {
    const summary = readDecisionSummaryFixture(
      "legacy-cancelled-run-is-notEstablished",
    );
    renderSummary(summary);

    expect(screen.getByTestId("run-decision-undecided")).toHaveTextContent(
      "the run stopped before it finished",
    );
  });

  it("says when a v2 decision could not be read at all", () => {
    const summary = readDecisionSummaryFixture("policyV2-decision-unreadable");
    renderSummary(summary);

    expect(screen.getByTestId("run-decision-undecided")).toHaveTextContent(
      "its decision could not be read",
    );
  });

  it("renders inconclusive with the validity reasons that produced it", () => {
    const summary = readDecisionSummaryFixture(
      "inconclusive-evaluator-errors-above-ceiling",
    );
    renderSummary(summary);

    expect(screen.getByTestId("run-decision-verdict")).toHaveTextContent(
      "Inconclusive",
    );
    expect(screen.getByTestId("run-decision-validity")).toHaveTextContent(
      "Validity phase did not hold",
    );
    expect(screen.getByTestId("run-decision-reasons")).toHaveTextContent(
      "the evaluator failed too often for this run to describe the server",
    );
  });

  it("names the reason a run graded nothing", () => {
    const summary = readDecisionSummaryFixture(
      "inconclusive-no-gradeable-trials",
    );
    renderSummary(summary);

    expect(screen.getByTestId("run-decision-reasons")).toHaveTextContent(
      "nothing in the run produced a gradeable verdict",
    );
  });
});

describe("stage and category copy", () => {
  it("names the first failed stage in human words, at every stage", () => {
    const summary = readDecisionSummaryFixture(
      "measured-failure-at-every-stage",
    );
    renderSummary(summary);

    const card = screen.getByTestId("run-decision-summary");
    for (const label of [
      "Connection",
      "Discovery",
      "Selection",
      "Tool call",
      "Response",
      "User value",
    ]) {
      expect(card).toHaveTextContent(`First failed stage: ${label}`);
    }
  });

  it("keeps a stage-less outcome stage-less", () => {
    const summary = readDecisionSummaryFixture(
      "category-without-first-failed-stage",
    );
    renderSummary(summary);

    const card = screen.getByTestId("run-decision-summary");
    expect(card).toHaveTextContent(
      "First failed stage: none was established — the run never reached the server's stages",
    );
    // Both stage-less categories still name the bucket the run is grouped
    // under; only the STAGE is withheld.
    expect(card).toHaveTextContent("Failure category: setup");
    expect(card).toHaveTextContent("Failure category: evaluator");
  });

  it("withholds both claims when the stored chain did not validate", () => {
    const summary = readDecisionSummaryFixture("unverified-and-version-ahead");
    renderSummary(summary);

    const card = screen.getByTestId("run-decision-summary");
    expect(card).toHaveTextContent(
      "First failed stage: not established — the recorded stage chain did not validate",
    );
    expect(card).toHaveTextContent("Failure category: not reported");
    expect(card).toHaveTextContent(
      "This trial's stage chain did not validate",
    );
  });

  it("flags a version-ahead derivation instead of rejecting it", () => {
    const summary = readDecisionSummaryFixture("unverified-and-version-ahead");
    renderSummary(summary);

    expect(screen.getByTestId("run-decision-summary")).toHaveTextContent(
      /Recorded by stage analyzer v\d+, newer than the v\d+ this build knows/,
    );
  });

  it("says a policy block was not measured rather than blaming the server", () => {
    const summary = readDecisionSummaryFixture(
      "policy-block-is-not-a-failure",
    );
    renderSummary(summary);
    const card = screen.getByTestId("run-decision-summary");

    fireEvent.click(within(card).getByRole("button", { expanded: false }));

    expect(card).toHaveTextContent(
      "a policy blocked the run before it could be measured",
    );
  });

  /**
   * The first diagnostic's expandable body.
   *
   * `hidden={!expanded}` leaves every trial's body in the DOM, so a query over
   * the whole card sees six cards per trial and picks whichever came first in
   * document order. Scoping to one body is what makes an assertion about "this
   * trial's chain" mean that.
   */
  function diagnosticBodies(card: HTMLElement): HTMLElement[] {
    return Array.from(
      card.querySelectorAll<HTMLElement>('[id^="run-decision-diagnostic-"]'),
    );
  }

  function firstDiagnostic(card: HTMLElement): HTMLElement {
    const body = diagnosticBodies(card)[0];
    if (!body) throw new Error("no diagnostic body rendered");
    return body;
  }

  it("renders every stage row as a card once a trial is expanded", () => {
    const summary = readDecisionSummaryFixture(
      "measured-failure-at-every-stage",
    );
    renderSummary(summary);
    const card = screen.getByTestId("run-decision-summary");

    for (const trigger of within(card).getAllByRole("button", {
      expanded: false,
    })) {
      fireEvent.click(trigger);
    }

    // The three non-verdicts stay three different sentences: "we did not
    // check", "it does not apply" and "it never ran" are different facts.
    expect(card).toHaveTextContent("never ran (an earlier stage failed)");
    // The rows are cards now, not "Connection: passed" text. Scoped to ONE
    // diagnostic each time: the expandable body stays in the DOM behind
    // `hidden`, so a document-wide query would span every trial in the run.
    //
    // This fixture walks the break across all six stages, so the first trial
    // broke AT connection and the last one got all the way to user value.
    const bodies = diagnosticBodies(card);
    const brokeAtConnection = within(bodies[0]!).getByTestId(
      "stage-chain-card-connection",
    );
    expect(brokeAtConnection).toHaveTextContent(
      USER_VALUE_STAGE_LABELS.connection,
    );
    expect(brokeAtConnection).toHaveAttribute("data-chip", "failed");

    // …and where connection held, it wears its OUTCOME phrase rather than the
    // word "passed", so the row reads as the delivery story.
    const connectionHeld = within(bodies[bodies.length - 1]!).getByTestId(
      "stage-chain-card-connection",
    );
    expect(connectionHeld).toHaveTextContent(
      USER_VALUE_STAGE_OUTCOMES.connection,
    );
    expect(connectionHeld).toHaveAttribute("data-chip", "passed");
  });

  it("opens on the first failed stage, and lets a reader close it", () => {
    const summary = readDecisionSummaryFixture(
      "measured-failure-at-every-stage",
    );
    renderSummary(summary);
    const card = screen.getByTestId("run-decision-summary");
    fireEvent.click(
      within(card).getAllByRole("button", { expanded: false })[0]!,
    );
    const body = firstDiagnostic(card);

    // The contract named the stage; the card row opened on it rather than on
    // a stage this component picked for itself.
    const opened = within(body)
      .getByTestId("trial-stage-detail-card")
      .getAttribute("data-stage");
    expect(opened).toBeTruthy();
    const openedCard = within(body).getByTestId(`stage-chain-card-${opened}`);
    expect(openedCard).toHaveAttribute("aria-pressed", "true");

    // A second click on the open card closes it — the `null` path, distinct
    // from "not chosen yet".
    fireEvent.click(openedCard);
    expect(within(body).queryByTestId("trial-stage-detail-card")).toBeNull();
  });

  it("shows no card row for a chain that was withheld", () => {
    // `unverified` withheld its rows deliberately. It must not render as an
    // empty six-card chain that reads as measured.
    const summary = readDecisionSummaryFixture("unverified-and-version-ahead");
    renderSummary(summary);
    const card = screen.getByTestId("run-decision-summary");
    for (const trigger of within(card).getAllByRole("button", {
      expanded: false,
    })) {
      fireEvent.click(trigger);
    }

    // This fixture pairs a withheld chain with a verified one, which is the
    // point: the withheld trial shows no cards while its neighbour still does,
    // so "no cards" is a statement about THAT trial rather than about the run.
    expect(
      within(firstDiagnostic(card)).queryByTestId("stage-chain-cards"),
    ).toBeNull();
    expect(card).toHaveTextContent("did not validate");
    expect(within(card).getAllByTestId("stage-chain-cards")).toHaveLength(1);
  });
});

describe("counts and their unit", () => {
  it("calls a legacy run's numbers trials, and says the run is legacy", () => {
    const summary = readDecisionSummaryFixture("legacy-run-trial-counts");
    renderSummary(summary);

    const card = screen.getByTestId("run-decision-summary");
    expect(screen.getByTestId("run-decision-counts")).toHaveTextContent(
      "trial",
    );
    expect(card).toHaveTextContent("these are trials, not cases");
    expect(screen.getByTestId("run-decision-verdict-source")).toHaveTextContent(
      "legacy percent-threshold run",
    );
  });

  it("leaves an absent legacy total absent rather than calling it zero", () => {
    const summary = readDecisionSummaryFixture("legacy-run-without-counts");
    renderSummary(summary);

    expect(screen.queryByTestId("run-decision-counts")).toBeNull();
    expect(screen.getByTestId("run-decision-summary")).toHaveTextContent(
      "This run reports no counts.",
    );
  });

  it("keeps a failing trial visible under a case that passed on threshold", () => {
    const summary = readDecisionSummaryFixture(
      "mixed-repetitions-case-passes-by-threshold",
    );
    renderSummary(summary);

    // The run PASSED and there are still non-passing trials under it. Tallying
    // these rows instead of reading the decision would produce a different
    // verdict from the same run.
    expect(screen.getByTestId("run-decision-verdict")).toHaveTextContent(
      "Passed",
    );
    expect(summary.diagnostics.items.length).toBeGreaterThan(0);
    expect(screen.getByTestId("run-decision-diagnostics-scope")).toHaveTextContent(
      `${summary.diagnostics.items.length} non-passing of ${summary.diagnostics.scannedIterations} trials examined`,
    );
  });

  it("reports a case that missed its threshold as failed", () => {
    const summary = readDecisionSummaryFixture(
      "mixed-repetitions-case-fails-by-threshold",
    );
    renderSummary(summary);

    expect(screen.getByTestId("run-decision-verdict")).toHaveTextContent(
      "Failed",
    );
    expect(screen.getByTestId("run-decision-reasons")).toHaveTextContent(
      "a case did not meet its pass threshold",
    );
  });
});

describe("completeness", () => {
  it("says a complete page is the whole non-passing set", () => {
    const summary = readDecisionSummaryFixture("policyV2-passing");
    renderSummary(summary);

    expect(
      screen.getByTestId("run-decision-diagnostics-scope"),
    ).toHaveTextContent("this is the run's whole non-passing set");
    expect(screen.queryByTestId("run-decision-load-more")).toBeNull();
  });

  it("says a partial page is partial, and offers the next one", () => {
    const summary = readDecisionSummaryFixture("partial-diagnostics-page");
    renderSummary(summary);

    expect(
      screen.getByTestId("run-decision-diagnostics-scope"),
    ).toHaveTextContent("partial: more trials have not been examined");
    expect(screen.getByTestId("run-decision-load-more")).toBeInTheDocument();
  });

  it("does not call a finished local walk a complete set", () => {
    const summary = readDecisionSummaryFixture("partial-diagnostics-page");
    renderSummary(summary, { walkExhausted: true, canLoadMore: false });

    const scope = screen.getByTestId("run-decision-diagnostics-scope");
    expect(scope).toHaveTextContent(
      "every page offered has been loaded, but the run did not report the set as complete",
    );
    expect(scope.textContent).not.toMatch(/whole non-passing set/);
  });

  it("keeps the loaded pages on screen when a later page failed", () => {
    const summary = readDecisionSummaryFixture("partial-diagnostics-page");
    renderSummary(summary, {
      pageError: new EvalRunDecisionSummaryError(
        "requestFailed",
        "network down",
      ),
    });

    expect(screen.getByTestId("run-decision-verdict")).toHaveTextContent(
      "Failed",
    );
    expect(screen.getByTestId("run-decision-page-error")).toHaveTextContent(
      "The pages already loaded are unchanged",
    );
  });
});

describe("evidence and navigation", () => {
  it("offers a trace jump keyed by identity, not by the API path", () => {
    const summary = readDecisionSummaryFixture(
      "measured-failure-at-every-stage",
    );
    const onViewTrace = vi.fn();
    renderSummary(summary, { onViewTrace });
    const first = summary.diagnostics.items[0];

    fireEvent.click(
      screen.getByTestId(`run-decision-view-trace-${first.iterationId}`),
    );

    expect(onViewTrace).toHaveBeenCalledWith({
      runId: summary.runId,
      iterationId: first.iterationId,
      // The CASE travels with it: focusing an iteration goes through its case
      // editor, which is the one route that actually consumes an iteration id.
      testCaseId: first.testCaseId,
    });
    // The API path is a locator for the endpoint, not an app route, so it is
    // never rendered as a link.
    expect(
      screen.getByTestId("run-decision-summary").querySelector("a[href]"),
    ).toBeNull();
  });

  it("offers no trace jump when the evidence names another run", () => {
    const summary = readDecisionSummaryFixture(
      "measured-failure-at-every-stage",
    );
    const foreign: EvalRunDecisionSummary = {
      ...summary,
      diagnostics: {
        ...summary.diagnostics,
        items: summary.diagnostics.items.map((item) => ({
          ...item,
          evidence: { ...item.evidence, runId: "some-other-run" },
        })),
      },
    };
    renderSummary(foreign, { onViewTrace: vi.fn() });

    expect(
      screen.queryByTestId(
        `run-decision-view-trace-${summary.diagnostics.items[0].iterationId}`,
      ),
    ).toBeNull();
  });

  it("offers no trace jump when the diagnostic names no case", () => {
    // Without a case there is nowhere to send the reader: the viewer focuses an
    // iteration through its case. A button that lands on the current page
    // having opened nothing reads as broken, so it is not offered.
    const summary = readDecisionSummaryFixture(
      "measured-failure-at-every-stage",
    );
    const caseless: EvalRunDecisionSummary = {
      ...summary,
      diagnostics: {
        ...summary.diagnostics,
        items: summary.diagnostics.items.map(({ testCaseId: _drop, ...item }) => item),
      },
    };
    renderSummary(caseless, { onViewTrace: vi.fn() });

    expect(
      screen.queryByTestId(
        `run-decision-view-trace-${summary.diagnostics.items[0].iterationId}`,
      ),
    ).toBeNull();
  });

  it("shows the operator's next action for each non-passing trial", () => {
    const summary = readDecisionSummaryFixture(
      "measured-failure-at-every-stage",
    );
    renderSummary(summary);
    const card = screen.getByTestId("run-decision-summary");

    for (const trigger of within(card).getAllByRole("button", {
      expanded: false,
    })) {
      fireEvent.click(trigger);
    }

    for (const item of summary.diagnostics.items) {
      expect(card).toHaveTextContent(item.nextAction);
    }
  });

  it("keeps each trial's detail keyboard reachable and announced", () => {
    const summary = readDecisionSummaryFixture("partial-diagnostics-page");
    renderSummary(summary);
    const card = screen.getByTestId("run-decision-summary");
    const trigger = within(card).getByRole("button", { expanded: false });

    const detailId = trigger.getAttribute("aria-controls");
    expect(detailId).toBeTruthy();
    const detail = document.getElementById(detailId as string);
    // Collapsed detail is `hidden`, so it is out of the accessibility tree
    // rather than merely off-screen.
    expect(detail).not.toBeVisible();

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(detail).toBeVisible();
  });
});

describe("states that are not a summary", () => {
  it("renders nothing at all when the read is disabled", () => {
    const { container } = render(
      <RunDecisionSummaryCard
        status="disabled"
        summary={null}
        error={null}
        diagnostics={[]}
        scannedIterations={0}
        serverComplete={false}
        walkExhausted={false}
        canLoadMore={false}
        isLoadingMore={false}
        pageError={null}
        onLoadMore={() => {}}
        onRetryFailedPage={() => {}}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ["notFound", "No decision summary for this run"],
    [
      "routeUnavailable",
      "Decision summaries are not available on this deployment",
    ],
    ["invalidContract", "The decision summary did not match its contract"],
    ["requestFailed", "Couldn't load the decision summary"],
  ] as const)("tells %s apart from the others", (kind, copy) => {
    render(
      <RunDecisionSummaryCard
        status="error"
        summary={null}
        error={new EvalRunDecisionSummaryError(kind, "raw message")}
        diagnostics={[]}
        scannedIterations={0}
        serverComplete={false}
        walkExhausted={false}
        canLoadMore={false}
        isLoadingMore={false}
        pageError={null}
        onLoadMore={() => {}}
        onRetryFailedPage={() => {}}
      />,
    );

    expect(screen.getByTestId("run-decision-summary-error")).toHaveTextContent(
      copy,
    );
    // No verdict is invented for a run whose summary could not be read.
    expect(screen.queryByTestId("run-decision-verdict")).toBeNull();
  });

  it("announces the loading state rather than repainting silently", () => {
    render(
      <RunDecisionSummaryCard
        status="loading"
        summary={null}
        error={null}
        diagnostics={[]}
        scannedIterations={0}
        serverComplete={false}
        walkExhausted={false}
        canLoadMore={false}
        isLoadingMore={false}
        pageError={null}
        onLoadMore={() => {}}
        onRetryFailedPage={() => {}}
      />,
    );

    const live = screen
      .getByTestId("run-decision-summary")
      .querySelector('[aria-live="polite"]');
    expect(live).toHaveAttribute("aria-busy", "true");
  });
});

describe("isDiagnosticTraceable, extracted and pinned", () => {
  // The rule now has two callers — this card's row and the stage findings —
  // so the three conditions are pinned here rather than only observed through
  // one renderer's button.
  const diagnostic = readDecisionSummaryFixture(
    "measured-failure-at-every-stage",
  ).diagnostics.items[0]!;

  it("is traceable with a handler, a matching run and a case id", () => {
    expect(
      isDiagnosticTraceable(diagnostic, diagnostic.evidence.runId, () => {}),
    ).toBe(true);
  });

  it("is not traceable without a handler to call", () => {
    expect(
      isDiagnosticTraceable(diagnostic, diagnostic.evidence.runId, undefined),
    ).toBe(false);
  });

  it("is not traceable when the evidence names a DIFFERENT run", () => {
    // A locator that does not match the run on screen would navigate somewhere
    // this view cannot answer for.
    expect(isDiagnosticTraceable(diagnostic, "some-other-run", () => {})).toBe(
      false,
    );
  });

  it("is not traceable when the evidence names a different iteration", () => {
    const crossed = {
      ...diagnostic,
      evidence: { ...diagnostic.evidence, iterationId: "another-iteration" },
    };
    expect(
      isDiagnosticTraceable(crossed, crossed.evidence.runId, () => {}),
    ).toBe(false);
  });

  it("is not traceable without a case id", () => {
    // The app focuses an iteration THROUGH its case; without one there is
    // nowhere to send the reader, and a button that opens nothing reads as
    // broken.
    const caseless = { ...diagnostic };
    delete (caseless as { testCaseId?: string }).testCaseId;
    expect(
      isDiagnosticTraceable(caseless, caseless.evidence.runId, () => {}),
    ).toBe(false);
  });
});
