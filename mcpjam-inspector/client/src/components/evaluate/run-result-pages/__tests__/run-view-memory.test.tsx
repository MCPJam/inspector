import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  readRunView,
  rememberRunView,
  useRunScrollMemory,
} from "../run-view-memory";

describe("run view memory", () => {
  it("merges what each part of the grid remembers, per run", () => {
    rememberRunView("memory-a", { search: "refund", status: "failed" });
    rememberRunView("memory-a", { client: "Claude" });
    rememberRunView("memory-b", { view: "metrics" });
    expect(readRunView("memory-a")).toEqual({
      search: "refund",
      status: "failed",
      client: "Claude",
    });
    expect(readRunView("memory-b")).toEqual({ view: "metrics" });
  });

  it("reads and keeps nothing while the pages are off", () => {
    rememberRunView(undefined, { search: "refund" });
    expect(readRunView(undefined)).toEqual({});
  });

  function Grid({ runId, ready }: { runId: string; ready: boolean }) {
    const scroll = useRunScrollMemory(runId, ready);
    return <div data-testid="scroller" {...scroll} />;
  }

  it("restores scroll only once the rows have rendered", () => {
    rememberRunView("memory-scroll", { scrollTop: 480 });
    const { rerender } = render(<Grid runId="memory-scroll" ready={false} />);
    const scroller = screen.getByTestId("scroller");
    // A layout shift before the rows land does not overwrite the saved spot.
    fireEvent.scroll(scroller, { target: { scrollTop: 0 } });
    expect(readRunView("memory-scroll").scrollTop).toBe(480);

    rerender(<Grid runId="memory-scroll" ready />);
    expect(scroller.scrollTop).toBe(480);
    fireEvent.scroll(scroller, { target: { scrollTop: 120 } });
    expect(readRunView("memory-scroll").scrollTop).toBe(120);
  });
});
