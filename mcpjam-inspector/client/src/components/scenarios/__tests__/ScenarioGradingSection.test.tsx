/**
 * The grading section's job is the WIRE: percent in the UI, fraction on the
 * mutation; rubric serialized via `serializeRubricForWire`; enabled+empty
 * rejected before the backend ever sees it. `JourneyRubricEditor` is stubbed
 * — its id-preservation has its own tests.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JourneyCriterion } from "@/shared/journey-rubric";

const setProductionScoringMock = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/useScenarios", () => ({
  useScenarioMutations: () => ({
    setProductionScoring: setProductionScoringMock,
  }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/components/swarms/journey-rubric-editor", () => ({
  JourneyRubricEditor: ({
    value,
    onChange,
  }: {
    value: JourneyCriterion[];
    onChange: (next: JourneyCriterion[]) => void;
  }) => (
    <div>
      <span data-testid="rubric-count">{value.length}</span>
      <button
        type="button"
        onClick={() =>
          onChange([
            ...value,
            {
              id: "crit-new",
              predicate: { type: "noToolErrors" },
            } as JourneyCriterion,
          ])
        }
      >
        add check
      </button>
      <button type="button" onClick={() => onChange([])}>
        clear checks
      </button>
    </div>
  ),
}));

import { ScenarioGradingSection } from "../ScenarioGradingSection";
import type { ScenarioSettings } from "@/hooks/useScenarios";

const RUBRIC = [
  {
    id: "crit-quick",
    label: "Quick resolution",
    predicate: { type: "turnCountUnder", turns: 3 },
    // A client-only field the wire must NOT carry. Without something here the
    // serialization assertion below would pass whether the payload was
    // stripped or copied wholesale.
    draftScratch: "not for the wire",
  },
];

function scenarioWith(
  productionScoring: ScenarioSettings["productionScoring"],
): ScenarioSettings {
  return {
    scenarioId: "scenario-1",
    productionScoring,
  } as unknown as ScenarioSettings;
}

beforeEach(() => {
  setProductionScoringMock.mockReset().mockResolvedValue({ cleared: false });
});

describe("ScenarioGradingSection", () => {
  it("saves percent as a [0,1] fraction with the serialized rubric", async () => {
    const user = userEvent.setup();
    render(
      <ScenarioGradingSection
        scenario={scenarioWith({
          enabled: true,
          samplingRate: 1,
          rubric: RUBRIC,
        })}
      />,
    );

    const sampling = screen.getByLabelText("Sample");
    await user.clear(sampling);
    await user.type(sampling, "25");
    await user.click(screen.getByTestId("scenario-grading-save"));

    expect(setProductionScoringMock).toHaveBeenCalledTimes(1);
    const args = setProductionScoringMock.mock.calls[0][0];
    expect(args.scenarioId).toBe("scenario-1");
    expect(args.config.enabled).toBe(true);
    expect(args.config.samplingRate).toBe(0.25);
    // Serialized for the wire — id/label/predicate only, client-only fields
    // dropped. `toEqual` is exact, so the stray `draftScratch` on the input
    // would fail this if the payload were passed through unserialized.
    expect(args.config.rubric).toEqual([
      {
        id: "crit-quick",
        label: "Quick resolution",
        predicate: { type: "turnCountUnder", turns: 3 },
      },
    ]);
    expect(args.config.rubric[0]).not.toHaveProperty("draftScratch");
  });

  it("round-trips a fractional percent instead of rounding it away", async () => {
    const user = userEvent.setup();
    render(
      <ScenarioGradingSection
        scenario={scenarioWith({
          // 12.5% — a rate this very editor can author, so reopening must not
          // silently redefine it as 13%.
          enabled: true,
          samplingRate: 0.125,
          rubric: RUBRIC,
        })}
      />,
    );

    expect((screen.getByLabelText("Sample") as HTMLInputElement).value).toBe(
      "12.5",
    );

    // An unrelated edit must persist the rate it was shown, unchanged.
    await user.click(screen.getByTestId("scenario-grading-enabled"));
    await user.click(screen.getByTestId("scenario-grading-save"));
    expect(setProductionScoringMock.mock.calls[0][0].config.samplingRate).toBe(
      0.125,
    );
  });

  it("shows a whole percent without float noise", () => {
    render(
      <ScenarioGradingSection
        scenario={scenarioWith({
          // 0.07 * 100 is 7.000000000000001 in IEEE 754.
          enabled: true,
          samplingRate: 0.07,
          rubric: RUBRIC,
        })}
      />,
    );
    expect((screen.getByLabelText("Sample") as HTMLInputElement).value).toBe(
      "7",
    );
  });

  it("treats a blank sampling field as unset, never as 0%", async () => {
    const user = userEvent.setup();
    render(
      <ScenarioGradingSection
        scenario={scenarioWith({ enabled: true, samplingRate: 1, rubric: RUBRIC })}
      />,
    );

    await user.clear(screen.getByLabelText("Sample"));

    expect(
      screen.getByText("Sampling must be a number between 0 and 100."),
    ).toBeTruthy();
    expect(
      (screen.getByTestId("scenario-grading-save") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(setProductionScoringMock).not.toHaveBeenCalled();
  });

  it("keeps the form dirty when an edit lands mid-save", async () => {
    const user = userEvent.setup();
    let resolveSave: (() => void) | undefined;
    setProductionScoringMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = () => resolve();
        }),
    );

    render(
      <ScenarioGradingSection
        scenario={scenarioWith({ enabled: true, samplingRate: 1, rubric: RUBRIC })}
      />,
    );

    const sampling = screen.getByLabelText("Sample");
    await user.clear(sampling);
    await user.type(sampling, "25");
    await user.click(screen.getByTestId("scenario-grading-save"));

    // The user keeps editing while the request is in flight.
    await user.clear(sampling);
    await user.type(sampling, "40");
    resolveSave?.();

    // The newer edit was never sent, so Save must stay live for it.
    await waitFor(() => {
      expect(
        (screen.getByTestId("scenario-grading-save") as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
  });

  it("save stays disabled while pristine", () => {
    render(scenarioSection());
    expect(
      (screen.getByTestId("scenario-grading-save") as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    function scenarioSection() {
      return (
        <ScenarioGradingSection
          scenario={scenarioWith({
            enabled: true,
            samplingRate: 1,
            rubric: RUBRIC,
          })}
        />
      );
    }
  });

  it("blocks enabling with an empty rubric — the error the backend would throw", async () => {
    const user = userEvent.setup();
    render(<ScenarioGradingSection scenario={scenarioWith(null)} />);

    await user.click(
      screen.getByTestId("scenario-grading-enabled"),
    );

    expect(
      screen.getByText("Add at least one check to enable grading."),
    ).toBeTruthy();
    expect(
      (screen.getByTestId("scenario-grading-save") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    // Adding a check clears the block.
    await user.click(screen.getByText("add check"));
    expect(
      (screen.getByTestId("scenario-grading-save") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(setProductionScoringMock).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range sampling percent client-side", async () => {
    const user = userEvent.setup();
    render(
      <ScenarioGradingSection
        scenario={scenarioWith({ enabled: true, samplingRate: 1, rubric: RUBRIC })}
      />,
    );

    const sampling = screen.getByLabelText("Sample");
    await user.clear(sampling);
    await user.type(sampling, "150");

    expect(
      screen.getByText("Sampling must be a number between 0 and 100."),
    ).toBeTruthy();
    expect(
      (screen.getByTestId("scenario-grading-save") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
