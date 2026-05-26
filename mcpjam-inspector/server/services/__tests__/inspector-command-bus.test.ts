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

  it("allows same-client reconnects without poisoning the active client id", async () => {
    const bus = new InspectorCommandBus();
    const first = createSubscriber("same-tab");
    const reconnect = createSubscriber("same-tab");
    const secondReconnect = createSubscriber("same-tab");

    bus.registerSubscriber(first);
    bus.registerSubscriber(reconnect);

    expect(first.supersede).toHaveBeenCalledTimes(1);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(reconnect.supersede).not.toHaveBeenCalled();
    expect(reconnect.close).not.toHaveBeenCalled();

    bus.registerSubscriber(secondReconnect);

    expect(reconnect.supersede).toHaveBeenCalledTimes(1);
    expect(reconnect.close).toHaveBeenCalledTimes(1);
    expect(secondReconnect.supersede).not.toHaveBeenCalled();
    expect(secondReconnect.close).not.toHaveBeenCalled();

    const command: InspectorCommand = {
      id: "cmd-2",
      type: "navigate",
      payload: { target: "app-builder" },
    };
    const pending = bus.submit(command, 1_000);

    expect(secondReconnect.send).toHaveBeenCalledWith(command);

    bus.complete({ id: "cmd-2", status: "success" });
    await expect(pending).resolves.toEqual({
      id: "cmd-2",
      status: "success",
    });
  });

  it("preserves pending commands on same-client reconnect", async () => {
    const bus = new InspectorCommandBus();
    const first = createSubscriber("same-tab");
    const reconnect = createSubscriber("same-tab");
    const command: InspectorCommand = {
      id: "cmd-same-reconnect",
      type: "navigate",
      payload: { target: "app-builder" },
    };

    bus.registerSubscriber(first);
    const pending = bus.submit(command, 1_000);

    expect(first.send).toHaveBeenCalledWith(command);

    bus.registerSubscriber(reconnect);
    bus.complete({ id: "cmd-same-reconnect", status: "success" });

    await expect(pending).resolves.toEqual({
      id: "cmd-same-reconnect",
      status: "success",
    });
  });

  it("rejects pending commands when a subscriber is replaced", async () => {
    const bus = new InspectorCommandBus();
    const first = createSubscriber("first-tab");
    const second = createSubscriber("second-tab");
    const command: InspectorCommand = {
      id: "cmd-replaced",
      type: "navigate",
      payload: { target: "app-builder" },
    };

    bus.registerSubscriber(first);
    const pending = bus.submit(command, 1_000);

    expect(first.send).toHaveBeenCalledWith(command);

    bus.registerSubscriber(second);

    await expect(pending).resolves.toEqual({
      id: "cmd-replaced",
      status: "error",
      error: {
        code: "no_active_client",
        message:
          "The active Inspector client was replaced before the command completed.",
      },
    });
  });
});
