import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EventConnectionCard } from "../EventConnectionCard";
import type { PlaygroundEventBinding } from "../PlaygroundEventsProvider";
import { eventTime } from "../recent-events";

const sentAt = new Date(2026, 10, 25, 14, 59, 8).getTime();
const skippedAt = new Date(2026, 10, 25, 15, 2, 41).getTime();

const binding = (
  fields: Partial<PlaygroundEventBinding> = {},
): PlaygroundEventBinding => ({
  id: "binding",
  subscriptionId: "row",
  logicalId: "logical",
  serverName: "Flights",
  eventName: "flight.status_changed",
  instructions: "Rebook if delayed",
  enabled: true,
  afterSeq: 0,
  agentScope: "chat:client",
  ownerScope: "project:host:true",
  event: { name: "flight.status_changed", delivery: ["poll"] },
  title: "Rebook MJ204 if cancelled or delayed 3h+",
  ...fields,
});

function renderCard(fields?: Partial<PlaygroundEventBinding>) {
  const actions = {
    onTrigger: vi.fn(),
    onEdit: vi.fn(),
    onTogglePause: vi.fn(),
  };
  render(
    <EventConnectionCard
      binding={binding(fields)}
      status="Listening"
      connected
      hosted={false}
      {...actions}
    />,
  );
  return actions;
}

describe("EventConnectionCard", () => {
  it("stays closed until opened, with the last event in the summary", () => {
    renderCard({
      recentEvents: [
        {
          key: "a",
          receivedAt: sentAt,
          origin: "poll",
          outcome: { status: "sent", message: "Event sent to agent" },
        },
      ],
    });
    expect(
      screen.getByText(
        `Flights · Listening · Last event ${eventTime(sentAt, { seconds: false })}`,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Trigger event" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Recent events" })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("opens to recent events and the connection's actions", () => {
    const actions = renderCard({
      recentEvents: [
        {
          key: "b",
          receivedAt: skippedAt,
          origin: "poll",
          outcome: { status: "skipped", message: "Agent busy" },
        },
        {
          key: "a",
          receivedAt: sentAt,
          origin: "simulation",
          outcome: { status: "sent", message: "Event sent to agent" },
        },
      ],
    });
    fireEvent.click(
      screen.getByRole("button", { name: /flight\.status_changed/ }),
    );
    const rows = within(
      screen.getByRole("list", { name: "Recent events" }),
    ).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      `${eventTime(skippedAt)}Skipped`,
      `${eventTime(sentAt)}Test · Sent to agent`,
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Trigger event" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit instructions" }));
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(actions.onTrigger).toHaveBeenCalledOnce();
    expect(actions.onEdit).toHaveBeenCalledOnce();
    expect(actions.onTogglePause).toHaveBeenCalledOnce();
  });

  it("shows why the latest event was not sent while closed", () => {
    renderCard({
      recentEvents: [
        {
          key: "b",
          receivedAt: skippedAt,
          origin: "poll",
          outcome: { status: "skipped", message: "Agent busy" },
        },
      ],
    });
    expect(screen.getByRole("status")).toHaveTextContent("Agent busy");
  });

  it("shows a notice about the connection while closed", () => {
    renderCard({
      enabled: false,
      notice: "Page restored. Resume to listen for new events.",
    });
    expect(screen.getByRole("status")).toHaveTextContent("Page restored.");
  });

  it("counts queued events and offers the action they wait for", () => {
    const onRunQueued = vi.fn();
    render(
      <EventConnectionCard
        binding={binding()}
        status="Listening"
        connected
        hosted={false}
        onTrigger={vi.fn()}
        onEdit={vi.fn()}
        onTogglePause={vi.fn()}
        queued={4}
        action={{ kind: "catch-up", count: 4 }}
        onRunQueued={onRunQueued}
      />,
    );
    expect(screen.getByText(/4 queued/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run 4 events" }));
    expect(onRunQueued).toHaveBeenCalledOnce();
  });

  it("offers Try again for an event that couldn't start", () => {
    render(
      <EventConnectionCard
        binding={binding()}
        status="Listening"
        connected
        hosted={false}
        onTrigger={vi.fn()}
        onEdit={vi.fn()}
        onTogglePause={vi.fn()}
        queued={1}
        action={{ kind: "retry", count: 1 }}
        onRunQueued={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
