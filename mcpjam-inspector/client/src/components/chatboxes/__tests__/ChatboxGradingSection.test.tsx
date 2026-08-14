/**
 * The grading section's job is the WIRE: percent in the UI, fraction on the
 * mutation; rubric serialized via `serializeRubricForWire`; enabled+empty
 * rejected before the backend ever sees it. `JourneyRubricEditor` is stubbed
 * — its id-preservation has its own tests.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JourneyCriterion } from "@/shared/journey-rubric";

const setProductionScoringMock = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/useChatboxes", () => ({
  useChatboxMutations: () => ({
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

import { ChatboxGradingSection } from "../ChatboxGradingSection";
import type { ChatboxSettings } from "@/hooks/useChatboxes";

const RUBRIC = [
  {
    id: "crit-quick",
    label: "Quick resolution",
    predicate: { type: "turnCountUnder", turns: 3 },
  },
];

function chatboxWith(
  productionScoring: ChatboxSettings["productionScoring"],
): ChatboxSettings {
  return {
    chatboxId: "chatbox-1",
    productionScoring,
  } as unknown as ChatboxSettings;
}

beforeEach(() => {
  setProductionScoringMock.mockReset().mockResolvedValue({ cleared: false });
});

describe("ChatboxGradingSection", () => {
  it("saves percent as a [0,1] fraction with the serialized rubric", async () => {
    const user = userEvent.setup();
    render(
      <ChatboxGradingSection
        chatbox={chatboxWith({
          enabled: true,
          samplingRate: 1,
          rubric: RUBRIC,
        })}
      />,
    );

    const sampling = screen.getByLabelText("Sample");
    await user.clear(sampling);
    await user.type(sampling, "25");
    await user.click(screen.getByTestId("chatbox-grading-save"));

    expect(setProductionScoringMock).toHaveBeenCalledTimes(1);
    const args = setProductionScoringMock.mock.calls[0][0];
    expect(args.chatboxId).toBe("chatbox-1");
    expect(args.config.enabled).toBe(true);
    expect(args.config.samplingRate).toBe(0.25);
    // Serialized for the wire — id/label/predicate only.
    expect(args.config.rubric).toEqual([
      {
        id: "crit-quick",
        label: "Quick resolution",
        predicate: { type: "turnCountUnder", turns: 3 },
      },
    ]);
  });

  it("save stays disabled while pristine", () => {
    render(chatboxSection());
    expect(
      (screen.getByTestId("chatbox-grading-save") as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    function chatboxSection() {
      return (
        <ChatboxGradingSection
          chatbox={chatboxWith({
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
    render(<ChatboxGradingSection chatbox={chatboxWith(null)} />);

    await user.click(
      screen.getByTestId("chatbox-grading-enabled"),
    );

    expect(
      screen.getByText("Add at least one check to enable grading."),
    ).toBeTruthy();
    expect(
      (screen.getByTestId("chatbox-grading-save") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    // Adding a check clears the block.
    await user.click(screen.getByText("add check"));
    expect(
      (screen.getByTestId("chatbox-grading-save") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(setProductionScoringMock).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range sampling percent client-side", async () => {
    const user = userEvent.setup();
    render(
      <ChatboxGradingSection
        chatbox={chatboxWith({ enabled: true, samplingRate: 1, rubric: RUBRIC })}
      />,
    );

    const sampling = screen.getByLabelText("Sample");
    await user.clear(sampling);
    await user.type(sampling, "150");

    expect(
      screen.getByText("Sampling must be a number between 0 and 100."),
    ).toBeTruthy();
    expect(
      (screen.getByTestId("chatbox-grading-save") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
