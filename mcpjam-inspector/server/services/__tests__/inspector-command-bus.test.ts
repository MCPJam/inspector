import { describe, expect, it, vi } from "vitest";
import type { InspectorCommand } from "@/shared/inspector-command.js";
import { InspectorCommandBus } from "../inspector-command-bus.js";

function createSubscriber(clientId: string) {
  return {
    clientId,
    send: vi.fn(),
    supersede: vi.fn(),
    close: vi.fn(),
  };
}

describe("InspectorCommandBus", () => {
  it("keeps a superseded EventSource reconnect from evicting the active subscriber", async () => {
    const bus = new InspectorCommandBus();
    const first = createSubscriber("first-tab");
    const second = createSubscriber("second-tab");
    const firstReconnect = createSubscriber("first-tab");

    bus.registerSubscriber(first);
    bus.registerSubscriber(second);

    expect(first.supersede).toHaveBeenCalledTimes(1);
    expect(first.close).toHaveBeenCalledTimes(1);

    bus.registerSubscriber(firstReconnect);

    expect(firstReconnect.supersede).toHaveBeenCalledTimes(1);
    expect(firstReconnect.close).toHaveBeenCalledTimes(1);
    expect(second.supersede).not.toHaveBeenCalled();
    expect(second.close).not.toHaveBeenCalled();

    const command: InspectorCommand = {
      id: "cmd-1",
      type: "navigate",
      payload: { target: "app-builder" },
    };
    const pending = bus.submit(command, 1_000);

    expect(second.send).toHaveBeenCalledWith(command);
    expect(firstReconnect.send).not.toHaveBeenCalled();

    bus.complete({ id: "cmd-1", status: "success" });
    await expect(pending).resolves.toEqual({
      id: "cmd-1",
      status: "success",
    });
  });
});
