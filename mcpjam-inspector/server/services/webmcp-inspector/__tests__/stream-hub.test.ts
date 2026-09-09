import { describe, expect, it } from "vitest";
import { WebMcpStreamHub } from "../stream-hub";
import type { WebMcpEvent } from "@/shared/webmcp-inspector-protocol";

function sessionEvent(seq: number): WebMcpEvent {
  return {
    type: "session",
    seq,
    session: {
      sessionId: "s1",
      status: "ready",
      url: "https://example.test/",
      createdAt: 1,
      expiresAt: 2,
      hardExpiresAt: 3,
      viewportTransport: { kind: "headless" },
      protocolVersion: 1,
    },
  };
}

function toolsEvent(seq: number, name: string): WebMcpEvent {
  return {
    type: "tools",
    seq,
    tools: [
      {
        toolKey: `https://example.test::${name}`,
        name,
        origin: "https://example.test",
        fromSubframe: false,
        description: name,
        registrationKind: "imperative",
      },
    ],
  };
}

function frameEvent(seq: number, data: string): WebMcpEvent {
  return {
    type: "frame",
    seq,
    frame: { data, deviceWidth: 1280, deviceHeight: 800, ts: seq },
  };
}

describe("WebMcpStreamHub", () => {
  it("replays only the latest full tools snapshot", () => {
    const hub = new WebMcpStreamHub(2);
    hub.publish(sessionEvent(1));
    hub.publish(toolsEvent(2, "first"));
    hub.publish(toolsEvent(3, "latest"));
    hub.publish({
      type: "activity",
      seq: 4,
      entry: { id: "a1", ts: 1, kind: "session_error", message: "x" },
    });

    const replayed: WebMcpEvent[] = [];
    hub.subscribe((event) => replayed.push(event));

    expect(replayed.map((event) => event.seq)).toEqual([1, 3, 4]);
    expect(replayed.find((event) => event.type === "tools")).toMatchObject({
      seq: 3,
      tools: [{ name: "latest" }],
    });
    expect(
      hub.buffered().filter((event) => event.type === "tools"),
    ).toHaveLength(1);
  });

  it("coalesces frames down to the current one", () => {
    const hub = new WebMcpStreamHub(200);
    hub.publish(frameEvent(1, "first"));
    hub.publish(frameEvent(2, "second"));
    hub.publish(frameEvent(3, "current"));

    const replayed: WebMcpEvent[] = [];
    hub.subscribe((event) => replayed.push(event));

    // A frame has no history worth replaying. The only one a reconnecting
    // client can act on is the one the page looks like now.
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({ seq: 3, frame: { data: "current" } });
  });

  it("never lets frames flush the activity ring", () => {
    const hub = new WebMcpStreamHub(200);
    for (let i = 0; i < 5; i++) {
      hub.publish({
        type: "activity",
        seq: i + 1,
        entry: { id: `a${i}`, ts: i, kind: "session_error", message: "x" },
      });
    }
    // Half a minute of a CSS spinner at 10fps. Through the ring this would
    // evict every tool registration and invocation the session recorded — the
    // timeline destroyed by the picture beside it.
    for (let i = 0; i < 300; i++) hub.publish(frameEvent(100 + i, `f${i}`));

    const replayed: WebMcpEvent[] = [];
    hub.subscribe((event) => replayed.push(event));

    expect(replayed.filter((event) => event.type === "activity")).toHaveLength(
      5,
    );
    expect(replayed.filter((event) => event.type === "frame")).toHaveLength(1);
  });

  it("replays the frame in seq order beside everything else", () => {
    const hub = new WebMcpStreamHub(200);
    hub.publish(sessionEvent(1));
    hub.publish(frameEvent(2, "paint"));
    hub.publish(toolsEvent(3, "echo"));
    hub.publish({
      type: "activity",
      seq: 4,
      entry: { id: "a1", ts: 1, kind: "session_error", message: "x" },
    });

    const replayed: WebMcpEvent[] = [];
    hub.subscribe((event) => replayed.push(event));

    expect(replayed.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(hub.buffered().map((event) => event.seq)).toEqual([1, 2, 3, 4]);
  });
});
