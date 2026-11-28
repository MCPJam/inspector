import { describe, expect, it } from "vitest";
import type { ManagerCallerContext } from "../../../routes/web/auth.js";
import { acquireSharedBus, openSharedBuses, sharedBusKey } from "../event-bus.js";

const never = () => {};
const toolsChanged = { kind: "tools_list_changed" } as const;

describe("the shared bus", () => {
  it("is one bus for requests with one key, and is dropped when the last of them ends", () => {
    const first = acquireSharedBus("one", never);
    const second = acquireSharedBus("one", never);
    const heard: unknown[] = [];
    second.bus.subscribe((event) => heard.push(event));
    first.bus.publish(toolsChanged);
    expect(heard).toEqual([toolsChanged]);
    expect(openSharedBuses()).toBe(1);
    first.release();
    expect(openSharedBuses()).toBe(1);
    second.release();
    expect(openSharedBuses()).toBe(0);
  });

  it("keeps requests with different keys apart", () => {
    const a = acquireSharedBus("a", never);
    const b = acquireSharedBus("b", never);
    const heard: unknown[] = [];
    b.bus.subscribe((event) => heard.push(event));
    a.bus.publish(toolsChanged);
    expect(heard).toEqual([]);
    a.release();
    b.release();
  });

  it("delivers what a task publishes after its request ended to a stream opened later", () => {
    // The request that started the task ended, and no stream held the bus.
    const started = acquireSharedBus("task", never);
    started.release();
    expect(openSharedBuses()).toBe(0);

    const stream = acquireSharedBus("task", never);
    const heard: unknown[] = [];
    stream.bus.subscribe((event) => heard.push(event));
    // The task's notifier still holds the bus its request had.
    started.bus.publish(toolsChanged);
    expect(heard).toEqual([toolsChanged]);
    stream.release();
    expect(openSharedBuses()).toBe(0);
  });
});

describe("the shared bus key", () => {
  const person = (workosUserId: string, mcpjamOrganizationId = "org1"): ManagerCallerContext => ({
    authMethod: "workos",
    workosUserId,
    mcpjamOrganizationId,
  });
  const key = (caller: ManagerCallerContext, bearerToken: string, run?: { runId: string; epoch: number }) =>
    sharedBusKey({ caller, bearerToken, mockId: "mock1", version: 2, ...(run && { run }) });

  it("keeps a signed-in person on one bus when their token is renewed", () => {
    expect(key(person("u1"), "token-a")).toBe(key(person("u1"), "token-b"));
  });

  it("keeps people, organizations and callers with no user apart", () => {
    expect(key(person("u1"), "t")).not.toBe(key(person("u2"), "t"));
    expect(key(person("u1", "org1"), "t")).not.toBe(key(person("u1", "org2"), "t"));
    const noUser: ManagerCallerContext = { authMethod: "guest" };
    expect(key(noUser, "guest-a")).not.toBe(key(noUser, "guest-b"));
  });

  it("gives each epoch of a test run its own bus", () => {
    expect(key(person("u1"), "t", { runId: "r1", epoch: 1 })).not.toBe(
      key(person("u1"), "t", { runId: "r1", epoch: 2 }),
    );
  });
});
