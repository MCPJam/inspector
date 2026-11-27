import { useLayoutEffect } from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  EventDescriptorView,
  EventsDeliveryModeView,
} from "@/shared/events-api";
import { useSubscribeForm } from "../use-subscribe-form";

const flightStatus: EventDescriptorView = {
  name: "flight.status_changed",
  delivery: ["poll", "push", "webhook"],
  inputSchema: {
    type: "object",
    properties: {
      tripId: { type: "string" },
      flightId: { type: "string" },
      statuses: { type: "array", items: { type: "string" } },
    },
    required: ["tripId", "flightId"],
  },
};

const orderShipped: EventDescriptorView = {
  name: "order.shipped",
  delivery: ["webhook"],
  inputSchema: {
    type: "object",
    properties: { orderId: { type: "string" } },
    required: ["orderId"],
  },
};

type Props = { event: EventDescriptorView; modes: EventsDeliveryModeView[] };

/** Renders the hook and records what each commit would paint. */
function renderForm(initialProps: Props) {
  const commits: Array<{
    event: string;
    fields: string[];
    rawMode: boolean;
    mode: EventsDeliveryModeView | null;
  }> = [];
  const hook = renderHook(
    ({ event, modes }: Props) => {
      const form = useSubscribeForm({
        event,
        modes,
        blockedReason: null,
        hosted: false,
        projectId: "project",
        serverId: "Flights",
        busy: false,
        onSubscribe: () => undefined,
      });
      useLayoutEffect(() => {
        commits.push({
          event: event.name,
          fields: form.fields.map((field) => field.name),
          rawMode: form.rawMode,
          mode: form.mode,
        });
      });
      return form;
    },
    { initialProps },
  );
  return { ...hook, commits };
}

describe("useSubscribeForm", () => {
  it("commits the event's parameters and a delivery mode on the first render", () => {
    const { commits } = renderForm({
      event: flightStatus,
      modes: ["poll", "push", "webhook"],
    });

    expect(commits[0]).toEqual({
      event: "flight.status_changed",
      fields: ["tripId", "flightId", "statuses"],
      rawMode: false,
      mode: "poll",
    });
    expect(new Set(commits.map((commit) => JSON.stringify(commit))).size).toBe(1);
  });

  it("never commits the previous event type's form after switching", () => {
    const { commits, rerender } = renderForm({
      event: flightStatus,
      modes: ["poll", "push", "webhook"],
    });
    const before = commits.length;

    rerender({ event: orderShipped, modes: ["webhook"] });

    const after = commits.slice(before);
    expect(after.length).toBeGreaterThan(0);
    for (const commit of after) {
      expect(commit).toEqual({
        event: "order.shipped",
        fields: ["orderId"],
        rawMode: false,
        mode: "webhook",
      });
    }
  });

  it("keeps the draft when a refresh re-lists the same event type", () => {
    const { result, rerender } = renderForm({
      event: flightStatus,
      modes: ["poll", "push", "webhook"],
    });
    act(() => {
      result.current.onFieldChange("tripId", "trip-1");
      result.current.setMode("push");
    });

    rerender({ event: { ...flightStatus }, modes: ["poll", "push", "webhook"] });

    expect(
      result.current.fields.find((field) => field.name === "tripId")?.value,
    ).toBe("trip-1");
    expect(result.current.mode).toBe("push");
  });

  it("uses the first allowed mode while the picked one is refused", () => {
    const { result, rerender } = renderForm({
      event: flightStatus,
      modes: ["poll", "push", "webhook"],
    });
    act(() => result.current.setMode("webhook"));

    rerender({ event: flightStatus, modes: ["poll"] });
    expect(result.current.mode).toBe("poll");

    rerender({ event: flightStatus, modes: [] });
    expect(result.current.mode).toBeNull();
    expect(result.current.canSubmit).toBe(false);
  });

  it("opens raw JSON on the first render when the schema has no fields", () => {
    const { commits } = renderForm({
      event: { name: "ping", delivery: ["poll"], inputSchema: { type: "object" } },
      modes: ["poll"],
    });

    expect(commits[0]).toMatchObject({ fields: [], rawMode: true, mode: "poll" });
  });
});
