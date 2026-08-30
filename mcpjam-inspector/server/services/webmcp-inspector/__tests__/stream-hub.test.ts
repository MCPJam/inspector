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
});
