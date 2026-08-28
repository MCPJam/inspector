import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  BenchResult,
  BenchScorecard,
  BenchSection,
} from "@/lib/apis/bench-api";
import { BenchReport } from "../BenchReport";

function section(
  overrides: Partial<BenchSection> & { section: BenchSection["section"] },
): BenchSection {
  return { coverage: "eligible", score: 80, ...overrides };
}

function sectioned(overrides: Partial<BenchScorecard> = {}): BenchScorecard {
  return {
    status: "scored",
    scores: { core: 90, category: 70, composite: 80 },
    sections: {
      coreProtocol: section({ section: "coreProtocol", score: 90 }),
      protocolExtensions: section({
        section: "protocolExtensions",
        score: null,
        coverage: "not_applicable",
      }),
      workflowReliability: section({
        section: "workflowReliability",
        score: 70,
      }),
      overall: 80,
    },
    ...overrides,
  };
}

function result(scorecard: BenchScorecard, extra: Partial<BenchResult> = {}) {
  return { runId: "run_1", scorecard, ...extra } satisfies BenchResult;
}

describe("v1 scorecards have no sections and are not dressed as if they did", () => {
  it("renders the three pooled numbers, named as v1's own", () => {
    // `sections` ABSENT is the only signal: `scores.core` and
    // `scores.composite` are populated for a v1 row too.
    render(
      <BenchReport
        result={result({
          status: "scored",
          scores: { core: 90, category: 70, composite: 80 },
        })}
      />,
    );

    expect(screen.getByLabelText("Scores")).toBeInTheDocument();
    expect(screen.getByText("Composite")).toBeInTheDocument();
    expect(screen.queryByLabelText("Sections")).not.toBeInTheDocument();
    expect(screen.queryByText("Overall")).not.toBeInTheDocument();
    expect(screen.queryByText("Core Protocol")).not.toBeInTheDocument();
  });

  it("renders sections, not the v1 numbers, when the read carries them", () => {
    render(<BenchReport result={result(sectioned())} />);

    expect(screen.getByLabelText("Sections")).toBeInTheDocument();
    expect(screen.getByText("Core Protocol")).toBeInTheDocument();
    expect(screen.getByText("Overall")).toBeInTheDocument();
    expect(screen.queryByLabelText("Scores")).not.toBeInTheDocument();
  });
});

describe("partial withholds the Overall and nothing else", () => {
  it("keeps the measured section scores and explains the missing Overall", () => {
    render(
      <BenchReport
        result={result(
          sectioned({
            status: "partial",
            sections: {
              coreProtocol: section({ section: "coreProtocol", score: 90 }),
              protocolExtensions: section({
                section: "protocolExtensions",
                score: 55,
              }),
              workflowReliability: section({
                section: "workflowReliability",
                score: null,
                coverage: "insufficient_evidence",
              }),
              overall: null,
              unmeasured: ["workflowReliability"],
            },
          }),
        )}
      />,
    );

    expect(screen.getByText("Partial")).toBeInTheDocument();
    // The measured sections keep real numbers — this is not a failure state.
    expect(screen.getByText("90")).toBeInTheDocument();
    expect(screen.getByText("55")).toBeInTheDocument();
    expect(
      screen.getByText(/No Overall\. It needs both Core Protocol/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Workflow Reliability did not\./),
    ).toBeInTheDocument();
  });
});

describe("an unmeasured slice is not a zero", () => {
  it("says not measured for a persona no case covered", () => {
    render(
      <BenchReport
        result={result(
          sectioned({
            slices: [
              {
                kind: "icp",
                slug: "support-agent",
                score: null,
                casesScored: 0,
                casesTagged: 0,
              },
              {
                kind: "goal",
                slug: "close-a-ticket",
                score: 64,
                casesScored: 4,
                casesTagged: 4,
              },
            ],
          }),
        )}
      />,
    );

    const slice = screen.getByText("support-agent").closest("li");
    expect(slice).toHaveTextContent(/not measured/);
    // "scores 0 for support agents" is a claim about the connector. This is not.
    expect(slice).not.toHaveTextContent(/\b0\b/);
    expect(screen.getByText("close-a-ticket").closest("li")).toHaveTextContent(
      "64",
    );
  });
});

describe("provenance and lifecycle labels", () => {
  it("marks a user-selected category as not registry verified", () => {
    render(
      <BenchReport
        result={result(sectioned(), {
          category: { slug: "crm", userSelected: true },
        })}
      />,
    );
    expect(
      screen.getByText("User-selected · not registry verified"),
    ).toBeInTheDocument();
  });

  /**
   * The lifecycle rides on the SCORECARD, which is where the backend nests it.
   * Passed at the result's top level — as these cases used to — it type-checks
   * (`BenchResult extends Record<string, unknown>`) and reads as `undefined`,
   * so the banner never renders and the test passes while asserting nothing.
   */
  it("labels a deprecated result instead of showing it as active", () => {
    render(
      <BenchReport
        result={result(
          sectioned({
            publication: { status: "deprecated", reason: "Superseded by v3." },
          }),
        )}
      />,
    );
    expect(screen.getByText(/was deprecated\./)).toBeInTheDocument();
    expect(screen.getByText("Superseded by v3.")).toBeInTheDocument();
  });

  it("labels a deleted result too, and says so without a reason", () => {
    render(
      <BenchReport
        result={result(sectioned({ publication: { status: "deleted" } }))}
      />,
    );
    expect(screen.getByText(/was deleted\./)).toBeInTheDocument();
    expect(
      screen.getByText(/no longer appears in leaderboards/),
    ).toBeInTheDocument();
  });

  it("shows an active scorecard with no withdrawal banner", () => {
    render(
      <BenchReport
        result={result(sectioned({ publication: { status: "active" } }))}
      />,
    );
    expect(screen.queryByText(/was deprecated\./)).not.toBeInTheDocument();
    expect(screen.queryByText(/was deleted\./)).not.toBeInTheDocument();
  });
});

describe("the two reruns read differently", () => {
  it("offers the same exam as a continuation and a new one as a new series", () => {
    render(
      <BenchReport
        result={result(sectioned(), {
          rerun: {
            sameHashVersion: "v2",
            latestVersion: "v3",
            definitionHashChanged: true,
          },
        })}
        onRerunSameExam={() => {}}
        onRerunLatestExam={() => {}}
      />,
    );

    expect(screen.getByText("Run again with v2")).toBeInTheDocument();
    expect(
      screen.getByText(/another point on this same comparison series/),
    ).toBeInTheDocument();
    expect(screen.getByText("Run the current exam (v3)")).toBeInTheDocument();
    expect(
      screen.getByText(/A new exam, and a new comparison series/),
    ).toBeInTheDocument();
  });

  it("does not offer the new-exam path when the hash did not move", () => {
    render(
      <BenchReport
        result={result(sectioned(), {
          rerun: {
            sameHashVersion: "v2",
            latestVersion: "v2",
            definitionHashChanged: false,
          },
        })}
        onRerunSameExam={() => {}}
        onRerunLatestExam={() => {}}
      />,
    );
    expect(
      screen.queryByText(/A new exam, and a new comparison series/),
    ).not.toBeInTheDocument();
  });
});

/**
 * The ledger is `{recorded, removed, residue}` and carries no status word.
 * These fixtures used to build a `{status, residueCount, detail}` shape that
 * nothing produces, which meant the panel's "everything was removed" default
 * was what a real payload would always have rendered.
 */
describe("cleanup is reported either way", () => {
  it("names what was left behind", () => {
    render(
      <BenchReport
        result={result(sectioned(), {
          cleanup: { status: "residue", residueCount: 2 },
        })}
      />,
    );
    expect(screen.getByText(/could not be removed/)).toBeInTheDocument();
    expect(screen.getByText(/2 items left behind/)).toBeInTheDocument();
  });

  it("claims removal only when everything recorded came back", () => {
    render(
      <BenchReport
        result={result(sectioned(), {
          cleanup: { status: "complete", residueCount: 0 },
        })}
      />,
    );
    expect(
      screen.getByText("Everything this run created was removed."),
    ).toBeInTheDocument();
  });

  it("does not claim removal while the counts still disagree", () => {
    render(
      <BenchReport
        result={result(sectioned(), {
          cleanup: { status: "pending", residueCount: 0 },
        })}
      />,
    );
    expect(screen.getByText(/Cleanup had not finished/)).toBeInTheDocument();
    expect(
      screen.queryByText("Everything this run created was removed."),
    ).not.toBeInTheDocument();
  });

  it("says nothing at all when no ledger was reported", () => {
    // Silence, not reassurance: "no cleanup reported" and "nothing was left
    // behind" are different claims, and this panel exists to keep them apart.
    render(<BenchReport result={result(sectioned())} />);
    expect(
      screen.queryByText(/removed|left behind|Cleanup/),
    ).not.toBeInTheDocument();
  });
});
