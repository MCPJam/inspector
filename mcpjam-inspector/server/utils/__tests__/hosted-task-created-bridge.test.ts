import { taskOwnerScope } from "../../../shared/task-owner";
import { describe, expect, it, vi } from "vitest";
import type { TaskCreatedEvent } from "@mcpjam/sdk";
import { HostedTaskCreatedBridge } from "../hosted-task-created-bridge";

const event: TaskCreatedEvent = {
  identity: { serverId: "server", taskId: "same", wire: "extension" },
  surface: "chat",
  wire: "extension",
};

describe("owned Task event delivery", () => {
  it("preserves legacy delivery without a new handshake", () => {
    const bridge = new HostedTaskCreatedBridge({
      serverNamesById: { server: "Display" },
    });
    const write = vi.fn();
    bridge.attachStreamWriter({ write });
    bridge.handle(event);
    expect(write.mock.calls[0][0].data).toMatchObject({
      serverId: "server",
      serverName: "Display",
      taskId: "same",
    });
    expect(write.mock.calls[0][0].data).not.toHaveProperty("ownerRequestId");
  });
  it.each(["account", "provenance"])(
    "refuses %s-bound delivery without owner correlation",
    (kind) => {
      const bridge = new HostedTaskCreatedBridge({ serverNamesById: {} });
      const write = vi.fn();
      bridge.attachStreamWriter({ write });
      bridge.handle({
        ...event,
        ...(kind === "account"
          ? { identity: { ...event.identity, connectionId: "account" } }
          : { sourceExecutionId: "execution" }),
      });
      expect(write).not.toHaveBeenCalled();
    },
  );
  it("preserves canonical identity, pin, provenance and request correlation together", () => {
    const bridge = new HostedTaskCreatedBridge({
      serverNamesById: { server: "Display" },
      ownerRequestId: "request-a",
      requestedOwnerScope: taskOwnerScope("project", "user"),
    });
    const write = vi.fn();
    bridge.attachStreamWriter({ write });
    bridge.bindOwner("project", "user");
    expect(bridge.canDeliverOwnedTasks).toBe(true);
    bridge.handle({
      ...event,
      identity: { ...event.identity, connectionId: "account" },
      sourceExecutionId: "execution",
    });
    expect(write.mock.calls[0][0].data).toMatchObject({
      serverId: "server",
      serverName: "Display",
      connectionId: "account",
      sourceExecutionId: "execution",
      ownerRequestId: "request-a",
      ownerScope: taskOwnerScope("project", "user"),
    });
  });
});


describe("authenticated Task owner", () => {
  it("rejects a request whose actual authenticated owner changed after submission", () => {
    const bridge = new HostedTaskCreatedBridge({ serverNamesById: {}, ownerRequestId: "request", requestedOwnerScope: taskOwnerScope("project", "a") });
    const write = vi.fn();
    bridge.attachStreamWriter({ write });
    bridge.bindOwner("project", "b");
    bridge.handle({ ...event, sourceExecutionId: "execution" });
    expect(bridge.canDeliverOwnedTasks).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(() => bridge.bindOwner("project", "a")).toThrow("owner cannot change");
  });
});
