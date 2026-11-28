import { useLayoutEffect } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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

type Props = {
  event: EventDescriptorView;
  modes: EventsDeliveryModeView[];
  hosted?: boolean;
  serverSignedIn?: boolean;
};

/** Renders the hook and records what each commit would paint. */
function renderForm(initialProps: Props) {
  const commits: Array<{
    event: string;
    fields: string[];
    rawMode: boolean;
    mode: EventsDeliveryModeView | null;
  }> = [];
  const hook = renderHook(
    ({ event, modes, hosted = false, serverSignedIn = false }: Props) => {
      const form = useSubscribeForm({
        event,
        modes,
        blockedReason: null,
        hosted,
        serverSignedIn,
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
      mode: "push",
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
      result.current.setMode("poll");
    });

    rerender({ event: { ...flightStatus }, modes: ["poll", "push", "webhook"] });

    expect(
      result.current.fields.find((field) => field.name === "tripId")?.value,
    ).toBe("trip-1");
    expect(result.current.mode).toBe("poll");
  });

  describe("defaults in the SEP's order", () => {
    const all: EventsDeliveryModeView[] = ["poll", "push", "webhook"];
    const receiverKey = `mcpjam-events-callback:${JSON.stringify(["project", "Flights"])}`;
    afterEach(() => window.localStorage.clear());

    it("hosted, a server that signs in: webhook", () => {
      const { result } = renderForm({
        event: flightStatus,
        modes: ["poll", "webhook"],
        hosted: true,
        serverSignedIn: true,
      });
      expect(result.current.mode).toBe("webhook");
    });

    it("hosted, a server with no sign-in: poll", () => {
      const { result } = renderForm({
        event: flightStatus,
        modes: ["poll", "webhook"],
        hosted: true,
      });
      expect(result.current.mode).toBe("poll");
    });

    it("local, an https receiver saved for a server that signs in: webhook", () => {
      window.localStorage.setItem(receiverKey, "https://tunnel.example.com/");
      const { result } = renderForm({
        event: flightStatus,
        modes: all,
        serverSignedIn: true,
      });
      expect(result.current.mode).toBe("webhook");
      expect(result.current.callbackUrl).toContain(
        "https://tunnel.example.com/",
      );
    });

    it("local, a plain-http receiver: push", () => {
      window.localStorage.setItem(receiverKey, "http://tunnel.example.com/");
      const { result } = renderForm({
        event: flightStatus,
        modes: all,
        serverSignedIn: true,
      });
      expect(result.current.mode).toBe("push");
    });

    it("keeps the default while the receiver URL is edited", () => {
      window.localStorage.setItem(receiverKey, "https://tunnel.example.com/");
      const { result } = renderForm({
        event: flightStatus,
        modes: all,
        serverSignedIn: true,
      });
      act(() => result.current.setCustomCallbackUrl("http://"));
      expect(result.current.mode).toBe("webhook");
    });
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
