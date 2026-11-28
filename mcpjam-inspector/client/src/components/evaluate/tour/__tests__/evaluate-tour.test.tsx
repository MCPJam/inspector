import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { track } from "@/lib/analytics";
import { EvaluateTour } from "../evaluate-tour";
import { useEvaluateTour } from "../use-evaluate-tour";
import { TOUR_STOPS } from "../evaluate-tour-steps";
import { AnnouncementDialog } from "@/components/announcement-popups";
import { AnnouncementQueueProvider } from "@/components/announcement-slot";
import { DialogDescription, DialogTitle } from "@mcpjam/design-system/dialog";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

// Reduced motion runs every transition without the cursor or timers.
vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("framer-motion")>();
  return { ...actual, useReducedMotion: () => true };
});

function Harness({
  eligible = true,
  onComplete = () => {},
}: {
  eligible?: boolean;
  onComplete?: () => void;
}) {
  const tour = useEvaluateTour({ autoOpenEligible: eligible, onComplete });
  return (
    <div>
      <button type="button" onClick={() => tour.open("replay")}>
        replay
      </button>
      <span data-testid="phase">{tour.phase}</span>
      <EvaluateTour tour={tour} />
    </div>
  );
}

describe("EvaluateTour", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(track).mockClear();
  });

  it("auto-opens once on an eligible empty landing", () => {
    const { unmount } = render(<Harness />);
    expect(screen.getByTestId("evaluate-tour-intro")).toBeInTheDocument();
    expect(track).toHaveBeenCalledWith(
      "evaluate_tour_opened",
      expect.objectContaining({ trigger: "auto" }),
    );
    unmount();

    render(<Harness />);
    expect(screen.queryByTestId("evaluate-tour-intro")).not.toBeInTheDocument();
  });

  it("stays closed until the landing is eligible", () => {
    render(<Harness eligible={false} />);
    expect(screen.getByTestId("phase")).toHaveTextContent("closed");
  });

  it("does not mark the automatic tour seen while another announcement owns the slot", () => {
    const tree = (blocker: boolean, enabled: boolean) => (
      <AnnouncementQueueProvider enabled={enabled}>
        <AnnouncementDialog eligible={blocker} onDismiss={vi.fn()}>
          <DialogTitle>Earlier announcement</DialogTitle>
          <DialogDescription>Test announcement.</DialogDescription>
        </AnnouncementDialog>
        <Harness />
      </AnnouncementQueueProvider>
    );
    const { rerender } = render(tree(true, false));
    expect(screen.queryByTestId("evaluate-tour-intro")).not.toBeInTheDocument();
    expect(localStorage.getItem("mcpjam-evaluate-tour-seen")).toBeNull();

    rerender(tree(true, true));
    expect(
      screen.getByRole("dialog", { name: "Earlier announcement" }),
    ).toBeVisible();
    expect(screen.queryByTestId("evaluate-tour-intro")).not.toBeInTheDocument();
    expect(localStorage.getItem("mcpjam-evaluate-tour-seen")).toBeNull();

    rerender(tree(false, true));
    expect(screen.getByTestId("evaluate-tour-intro")).toBeVisible();
    expect(localStorage.getItem("mcpjam-evaluate-tour-seen")).toBe("1");
  });

  it("still runs transitions after StrictMode's dev remount", async () => {
    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    fireEvent.click(screen.getByTestId("evaluate-tour-start"));
    await waitFor(() =>
      expect(screen.getByText(TOUR_STOPS[0].title)).toBeInTheDocument(),
    );
  });

  it("walks every stop and hands off to the create-suite form", async () => {
    const onComplete = vi.fn();
    render(<Harness onComplete={onComplete} />);

    fireEvent.click(screen.getByTestId("evaluate-tour-start"));

    for (const [index, stop] of TOUR_STOPS.entries()) {
      await waitFor(() =>
        expect(screen.getByText(stop.title)).toBeInTheDocument(),
      );
      expect(
        screen.getByTestId(`evaluate-tour-screen-${stop.screen}`),
      ).toBeInTheDocument();
      expect(
        screen.getByText(`${index + 1} of ${TOUR_STOPS.length}`),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByTestId("guided-tour-next"));
    }

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("phase")).toHaveTextContent("handoff");
    expect(track).toHaveBeenCalledWith(
      "evaluate_tour_completed",
      expect.objectContaining({ duration_ms: expect.any(Number) }),
    );
    expect(
      vi
        .mocked(track)
        .mock.calls.filter(([event]) => event === "evaluate_tour_step_viewed"),
    ).toHaveLength(TOUR_STOPS.length);
  });

  it("scrolls each stop's spotlight into view", async () => {
    const scrolled: (string | null)[] = [];
    const scrollIntoView = vi.fn(function (this: HTMLElement) {
      scrolled.push(this.getAttribute("data-tour-anchor"));
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    try {
      render(<Harness />);
      fireEvent.click(screen.getByTestId("evaluate-tour-start"));
      await waitFor(() =>
        expect(screen.getByText(TOUR_STOPS[0].title)).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByTestId("guided-tour-next"));
      await waitFor(() =>
        expect(screen.getByText(TOUR_STOPS[1].title)).toBeInTheDocument(),
      );
      expect(scrolled).toEqual([
        ...[...TOUR_STOPS[0].anchors].reverse(),
        ...[...TOUR_STOPS[1].anchors].reverse(),
      ]);
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  });

  it("closes on Skip tour and reports where", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("evaluate-tour-start"));
    await waitFor(() =>
      expect(screen.getByText(TOUR_STOPS[0].title)).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Skip tour" }));

    expect(screen.getByTestId("phase")).toHaveTextContent("closed");
    expect(screen.queryByTestId("evaluate-tour")).not.toBeInTheDocument();
    expect(track).toHaveBeenCalledWith(
      "evaluate_tour_skipped",
      expect.objectContaining({ step: "setup" }),
    );
  });

  it("reports the stop it was heading to when skipped mid-transition", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("evaluate-tour-start"));
    await waitFor(() =>
      expect(screen.getByText(TOUR_STOPS[0].title)).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("guided-tour-next"));
    await waitFor(() =>
      expect(
        screen.getByTestId(`evaluate-tour-screen-${TOUR_STOPS[1].screen}`),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(TOUR_STOPS[1].title)).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId("evaluate-tour"), { key: "Escape" });

    expect(screen.getByTestId("phase")).toHaveTextContent("closed");
    expect(track).toHaveBeenCalledWith(
      "evaluate_tour_skipped",
      expect.objectContaining({ step: TOUR_STOPS[1].id }),
    );
  });

  it("closes from the intro on Escape", () => {
    render(<Harness />);
    act(() => {
      fireEvent.keyDown(screen.getByTestId("evaluate-tour-start"), {
        key: "Escape",
      });
    });
    expect(screen.getByTestId("phase")).toHaveTextContent("closed");
    expect(track).toHaveBeenCalledWith(
      "evaluate_tour_skipped",
      expect.objectContaining({ step: "intro" }),
    );
  });

  it("replays from the header after it has been seen", () => {
    window.localStorage.setItem("mcpjam-evaluate-tour-seen", "1");
    render(<Harness />);
    expect(screen.getByTestId("phase")).toHaveTextContent("closed");

    fireEvent.click(screen.getByRole("button", { name: "replay" }));

    expect(screen.getByTestId("evaluate-tour-intro")).toBeInTheDocument();
    expect(track).toHaveBeenCalledWith(
      "evaluate_tour_opened",
      expect.objectContaining({ trigger: "replay" }),
    );
  });
});
