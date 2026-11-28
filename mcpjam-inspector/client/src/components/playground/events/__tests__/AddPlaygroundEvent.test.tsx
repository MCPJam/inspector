import { Profiler } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EventDescriptorView } from "@/shared/events-api";
import { AddPlaygroundEvent } from "../AddPlaygroundEvent";
import type { usePlaygroundEvents } from "../PlaygroundEventsProvider";

type Runtime = NonNullable<ReturnType<typeof usePlaygroundEvents>>;

const flightStatus: EventDescriptorView = {
  name: "flight.status_changed",
  description: "A simulated flight was delayed, cancelled, or restored.",
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

function runtimeWith(host: Runtime["host"]): Runtime {
  const partial: Partial<Runtime> = {
    projectId: "project",
    host,
    hosted: false,
    loading: false,
    refresh: vi.fn(async () => undefined),
    add: vi.fn(async () => undefined),
    addTest: vi.fn(),
    agentBlockedReason: null,
    servers: {
      Flights: {
        connectionStatus: "connected",
        config: { url: new URL("https://flights.example.com/mcp") },
      },
    } as Runtime["servers"],
    catalogs: [
      {
        serverName: "Flights",
        catalog: {
          events: [flightStatus],
          support: { handshakeObserved: true, declared: true, listChanged: false },
        },
      },
    ],
  };
  return partial as Runtime;
}

/** Opens the dialog, picks the event and returns the page text at each commit after the pick. */
function pickEvent(runtime: Runtime) {
  const frames: string[] = [];
  render(
    <Profiler
      id="add-playground-event"
      onRender={() => frames.push(document.body.textContent ?? "")}
    >
      <AddPlaygroundEvent runtime={runtime} onClose={vi.fn()} />
    </Profiler>,
  );
  const before = frames.length;
  fireEvent.click(screen.getByText("flight.status_changed"));
  return frames.slice(before);
}

describe("AddPlaygroundEvent", () => {
  it("shows the event's parameters and delivery mode from the first frame after picking it", () => {
    const frames = pickEvent(
      runtimeWith({ id: null, name: "MCPJam (built-in)", modes: ["poll", "push", "webhook"], missing: false }),
    );

    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame).not.toContain("No parameters required");
      expect(frame).not.toContain("Delivery · Unavailable");
      expect(frame).toContain("tripId");
      expect(frame).toContain("Delivery · push");
    }
  });

  it("says delivery is loading, not unavailable, while client settings load", () => {
    const frames = pickEvent(runtimeWith(undefined));

    expect(frames.at(-1)).toContain("Delivery · Loading…");
    expect(frames.at(-1)).toContain("tripId");
    for (const frame of frames) {
      expect(frame).not.toContain("Delivery · Unavailable");
    }
  });
});
