import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ActivityTimeline } from "../ActivityTimeline";
import type { WebMcpActivityEntry } from "@/shared/webmcp-inspector-protocol";

const ENTRIES: WebMcpActivityEntry[] = [
  { id: "a0", ts: 1_000, kind: "session_started", url: "https://pizza.test/" },
  {
    id: "a1",
    ts: 1_100,
    kind: "tools_added",
    tools: [
      {
        toolKey: "https://pizza.test::add_topping",
        name: "add_topping",
        origin: "https://pizza.test",
        fromSubframe: false,
      },
    ],
  },
  {
    id: "a2",
    ts: 1_200,
    kind: "invocation_settled",
    toolKey: "https://pizza.test::add_topping",
    invokeId: "inv-1",
    source: "manual",
    state: "succeeded",
    durationMs: 42,
    output: "Added 1 topping",
  },
];

describe("ActivityTimeline", () => {
  it("expands every row on click, including registrations", () => {
    render(<ActivityTimeline entries={ENTRIES} />);

    fireEvent.click(screen.getByText("add_topping"));
    expect(
      screen.getByText("https://pizza.test::add_topping"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText("https://pizza.test/"));
    expect(screen.getByText(/"kind": "session_started"/)).toBeInTheDocument();

    fireEvent.click(screen.getByText(/add_topping · 42ms/));
    expect(screen.getByText("Added 1 topping")).toBeInTheDocument();
  });

  it("clears the timeline from the toolbar", () => {
    const onClear = vi.fn();
    render(<ActivityTimeline entries={ENTRIES} onClear={onClear} />);

    fireEvent.click(screen.getByRole("button", { name: "Clear activity" }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("keeps clear visible and disabled when the timeline is empty", () => {
    render(<ActivityTimeline entries={[]} onClear={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Clear activity" })).toBeDisabled();
  });
});
